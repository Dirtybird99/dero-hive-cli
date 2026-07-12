// GLOBALS
let socket = null;						// Wallet XSWD connection
let daemonSocket = null;				// Direct daemon wss connection
let daemonEndpoint = null;				// To be defined in wallet response
let daemonEndpointRequested = false;	// Status check on endpoint request
let daemonReady = false;				// Becomes true when daemon connects
let indexRequested = false;				// So we can prevent double requests and clean up states
let daemonGraceTimeout = null;			// Grace timer for user to allow ask for endpoint, before closing all sockets
let myAddress = "";						// Actual user address, provided by wallet
window.myAddress = "";
let storeDevFee = null;					// Not enforced by SC, intent is to use funds donated via this front end to support community developers.
let pendingTXID = null;
let txTrackerInterval = null;
let indexResolve;
let triedWS = false;

let villager_scid = "f0b29081c1ed35fe942cb3402cd9d7bf0cf27639201bbc96223bdc99c4c6aa9f";
const valid_sc_owner = "dero1qyqqtsvggrfxtsz6p3yn49n26k83nnr50jmpnyqylykzju4wgl9yvqqdxdvse";

// AVATAR VALIDATION CONSTANTS
const VALID_PALETTE_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const VALID_CHARS_SET = new Set(VALID_PALETTE_CHARS);

// Validate that an avatar string contains only valid palette characters
function isValidAvatarString(str) {
    if (!str || typeof str !== 'string' || str.length !== 576) return false;
    for (let i = 0; i < str.length; i++) {
        if (!VALID_CHARS_SET.has(str[i])) return false;
    }
    return true;
}

// AVATAR COLOR MAP
const Char_To_Color = {
    '0': 0xFFFF9999, '1': 0xFFFF6666, '2': 0xFFFF0000, '3': 0xFF800000,
    '4': 0xFFFFA899, '5': 0xFFFF8C66, '6': 0xFFFF4500, '7': 0xFF802200,
    '8': 0xFFFFC799, '9': 0xFFFFB266, 'A': 0xFFFF8C00, 'B': 0xFF804600,
    'C': 0xFFFFE099, 'D': 0xFFFFD866, 'E': 0xFFFFAA00, 'F': 0xFF5C4033,
    'G': 0xFFFFFF99, 'H': 0xFFFFFF66, 'I': 0xFFFFFF00, 'J': 0xFFFFD700,
    'K': 0xFFCFFF99, 'L': 0xFFBFFF66, 'M': 0xFF80FF00, 'N': 0xFF408000,
    'O': 0xFF99FF99, 'P': 0xFF66FF66, 'Q': 0xFF00FF00, 'R': 0xFF008000,
    'S': 0xFF99FFCF, 'T': 0xFF66FFBF, 'U': 0xFF00FF80, 'V': 0xFF008040,
    'W': 0xFF99FFFF, 'X': 0xFF66FFFF, 'Y': 0xFF00FFFF, 'Z': 0xFF008080,
    'a': 0xFF99CFFF, 'b': 0xFF66BFFF, 'c': 0xFF0080FF, 'd': 0xFF004080,
    'e': 0xFF9999FF, 'f': 0xFF6666FF, 'g': 0xFF0000FF, 'h': 0xFF000080,
    'i': 0xFFCF99FF, 'j': 0xFFBF66FF, 'k': 0xFF8000FF, 'l': 0xFF400080,
    'm': 0xFFFF99FF, 'n': 0xFFFF66FF, 'o': 0xFFFF00FF, 'p': 0xFF800080,
    'q': 0xFFFF99C7, 'r': 0xFFFF66B2, 's': 0xFFFF0080, 't': 0xFF800040,
    'u': 0xFFFFFFFF, 'v': 0xFFB4B4B4, 'w': 0xFF848484, 'x': 0xFF434343,
    'y': 0xFF000000, 'z': 0x00000000
};

// XSWD APP DATA
const applicationData = {
    id: "C0FFEE42BADA55FACEDEAD10ABE1E505E5CAFE12D5EAD5BEEF42F00DFACA1E1D",
    name: "Villager Avatar Editor",
    description: "Avatar editor for social spaces built on DERO",
    url: "http://localhost:" + location.port,
    signature: btoa(`-----BEGIN DERO SIGNED MESSAGE-----
Address: dero1qyqqtsvggrfxtsz6p3yn49n26k83nnr50jmpnyqylykzju4wgl9yvqqdxdvse
C: 12c9cd4cf42aaa72d9a234114300e6679a69c67ae2e0f4643153a74912910e9d
S: 1237983cf26148dd79e8dbafae467ab8177f6576db4fb85db890494bb9816a9e

QzBGRkVFNDJCQURBNTVGQUNFREVBRDEwQUJFMUU1MDVFNUNBRkUxMkQ1RUFENUJF
RUY0MkYwMERGQUNBMUUxRA==
-----END DERO SIGNED MESSAGE-----`)
};

// CONNECT TO DAEMON (ws)
function connectToDaemon() {
    if (!daemonEndpoint) return;
    if (daemonSocket?.readyState === WebSocket.OPEN || daemonSocket?.readyState === WebSocket.CONNECTING) {
        console.log("Already connected/connecting to node", "color: lime");
        return;
    }

    let host = daemonEndpoint.trim();
    if (host.startsWith("ws://")) host = host.substring(5);
    if (host.startsWith("wss://")) host = host.substring(6);

    let url;
    if (triedWS) {
        url = "ws://" + host + "/ws";
    } else {
        url = "http://" + host + "/ws";
    }
    console.log("%cConnecting to node: " + url, "color: cyan");
    daemonSocket = new WebSocket(url);

	daemonSocket.onopen = () => {
		console.log("%cNode connected!", "color: lime");
		daemonReady = true;
		sendAlert("Connected to the DERO network!");

		// Cancel any pending fallback
		if (daemonGraceTimeout) {
			clearTimeout(daemonGraceTimeout);
			daemonGraceTimeout = null;
		}

		// If we were waiting to load index, do it now
		if (indexRequested && !document.querySelector(".alert")?.innerText.includes("population")) {
			console.log("%cNode connected in time, loading index now!", "color: lime");
			sendDaemonGetSC("index");
		}

		if (pendingTXID) {
			console.log("Resuming TX tracking...");
			doDaemonTracking();
		}
	};

    daemonSocket.onmessage = (e) => {
        try {
            const data = JSON.parse(e.data);
            handleDaemonMessage(data);
        } catch (e) {
            console.error("Node message parse error:", e);
        }
    };

	daemonSocket.onclose = (e) => {
		console.log("Node connection closed:", e.code);
		daemonSocket = null;
		daemonReady = false;

		indexRequested = false;

		if (e.code !== 1000) {
			sendAlert("Lost node connection, reconnecting...");
			setTimeout(() => daemonEndpoint && connectToDaemon(), 4000);
		}
	};

    daemonSocket.onerror = () => {
        console.error("Node WebSocket error :(");
        if (!triedWS) {
            triedWS = true;
            console.log("Trying WebSocket fallback...");
            connectToDaemon();
        } else {
            sendAlert("Failed to connect to node...");
        }
    };
}

// REQUEST DAEMON ENDPOINT
function requestDaemonEndpoint() {
    if (daemonEndpoint) {
        connectToDaemon();
        return;
    }
    if (daemonEndpointRequested) {
        console.log("Daemon endpoint already requested, waiting for user to allow...");
        return;
    }

    daemonEndpointRequested = true;
    console.log("Requesting daemon endpoint from wallet...");

    sendData({
        jsonrpc: "2.0",
        id: "get-daemon-endpoint",
        method: "GetDaemon"
    });
}

// DAEMON RESPONSE HANDLER
function handleDaemonMessage(data) {
    if (data.id?.includes("villager-index-daemon-") || data.id?.includes("villager-index-wallet-fallback-")) {
        handleGetSCResponse(data);
        return;
    }

    if (data.id?.includes("load-avatar-daemon-") || data.id?.includes("load-avatar-wallet-fallback-")) {
        handleAvatarLoadResponse(data);
        return;
    }

    // ———————— TX TRACKING ————————
    if (data.id !== "villager-track-tx" || !pendingTXID) return;

    const tx = data.result?.txs?.[0];
    if (!tx) {
        console.log("TX not yet visible at node..");
        return;
    }

    // 1. Still in mempool
    if (tx.in_pool) {
        console.log("%cTX in mempool, waiting for block inclusion...", "color: cyan", {
            txid: pendingTXID.substring(0, 12) + "..."
        });
        sendAlert("TX is in mempool, waiting for block..");
        return;
    }

    // 2. TX has left the pool and been assigned a block height
    if (tx.block_height > 0) {

        // SUCCESS: TX accepted into a valid block
        if (tx.valid_block !== null) {
            console.log("%cTransaction confirmed!", "color: lime", {
                txid: pendingTXID.substring(0, 12) + "...",
                block_height: tx.block_height,
                valid_block: tx.valid_block.substring(0, 16) + "...",
                confirmations: tx.confirmations || 0
            });
            sendAlert("Villager saved successfully!");
            stopTrackingTX(true);
            return;
        }

        // FAILURE: TX processed but rejected (orphaned, invalid, etc.)
        if (tx.valid_block === null) {
            console.log("%cTransaction rejected by network!", "color: red", {
                txid: pendingTXID,
                block_height: tx.block_height
            });
            sendAlert("TX rejected by the network.. :(");
            stopTrackingTX(false);
            return;
        }
    }

    // 3. Edge case, should never happen
    console.log("%cTX in unexpected state, continuing to monitor", "color: yellow", tx);
}

// SEND TO DAEMON
function sendToDaemon(obj) {
    if (daemonSocket?.readyState === WebSocket.OPEN) {
        daemonSocket.send(JSON.stringify(obj));
    }
}

// TX TRACKING LOGIC
function startTrackingTX(txid) {
    if (!txid) return;

    if (!daemonReady) {
        console.log("%cTX submitted, but cannot track with no node connection..", "color: red");
        sendAlert("Failed: Node connection lost or denied");
        pendingTXID = null;
        if (MainVMi) MainVMi.boolean("State.WaitingOnTX").value = false;
        return;
    }

    pendingTXID = txid;
    console.log("%cTracking TX: " + txid, "color: cyan");
    sendAlert("TX sent! Waiting for confirmation...");

    if (MainVMi) MainVMi.boolean("State.WaitingOnTX").value = true;

    doDaemonTracking();
}

function doDaemonTracking() {
    const check = () => {
        if (!pendingTXID) return;
        sendToDaemon({
            jsonrpc: "2.0",
            id: "villager-track-tx",
            method: "DERO.GetTransaction",
            params: { txs_hashes: [pendingTXID] }
        });
    };
    txTrackerInterval = setInterval(check, 3000);
    check();
}

function stopTrackingTX(success = false) {
    if (txTrackerInterval) clearInterval(txTrackerInterval);
    txTrackerInterval = null;
    pendingTXID = null;

    if (MainVMi) MainVMi.boolean("State.WaitingOnTX").value = false;

    if (success) {
        sendAlert("TX confirmed in a block!");
        indexRequested = false;
        getVillagerIndex();
        if (MainVMi?.boolean("State.UserAvatarExists")?.value) {
            setTimeout(loadAvatarFromChain, 1200);
        }
    }
}

// MAIN WALLET CONNECTION
function connectWebSocket() {
    if (socket) closeSocket();

    socket = new WebSocket("ws://localhost:44326/xswd");

    socket.onopen = () => {
        console.log("Connected to wallet (XSWD)");
        MainVMi.number("State.Connect").value = 2;
        sendAlert("Wallet connection requested (check wallet)..");
        sendData(applicationData);
    };

    socket.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            console.log("%cWallet Message", "color: lime", data);

            // 1. App accepted
			if (data.accepted) {
				console.log("%cXSWD Connection accepted by user", "color: gold");
				sendAlert("Connection accepted, asking for address!");
				sendData({
					jsonrpc: "2.0",
					id: "get-address",
					method: "GetAddress"
				});
				return;
			}

            // 2. Got address
            if (data.result?.address) {
                myAddress = data.result.address;
				window.myAddress = myAddress; // gallery.js needs it too
				console.log("User logged in with " + myAddress)
                MainVMi.number("State.Connect").value = 3;
                MainVMi.string("State.UserAddress").value = myAddress;
                sendAlert("Address received, asking for node endpoint!");
                requestDaemonEndpoint();
                setTimeout(getVillagerIndex, 600);
                return;
            }

            // 3. Got daemon endpoint
            if (typeof data.id === "string" && data.id.includes("get-daemon-endpoint") && data.result?.endpoint && !daemonEndpoint) {
				daemonEndpoint = data.result.endpoint;
				console.log("%cDirect node endpoint received: " + daemonEndpoint,  "color: gold");
				connectToDaemon();
				return;
			}

            // 4. Villager index (handles fallback call response at wallet)
            if (data.id?.includes("villager-index")) {
                handleGetSCResponse(data);
                return;
            }

            // 5. Avatar load (handles fallback call response at wallet) 
            if (data.id?.includes("load-avatar-") && data.result?.stringkeys) {
                handleAvatarLoadResponse(data);
                return;
            }

            // 6. TX submitted, we will track this transaction at the daemon
			if (data.result?.txid) {
				const idStr = String(data.id || "");
				if (idStr.includes("register-") || 
					idStr.includes("unregister-") || 
					idStr.includes("store-avatar-")) {
					console.log("%cTX submitted: " + data.result.txid, "color: lime");
					startTrackingTX(data.result.txid);
					return;
				}
			}

            // 7. Wallet error
			if (data.error) {
				console.error("%cWallet error: ", "color: red", data.error);
				// CATCH GETADDRESS DENIAL
				if (String(data.id || "").includes("get-address") && data.error?.code === -32043) {
					console.log("%cUser denied GetAddress, shutting down..", "color: red");

					MainVMi.number("State.Connect").value = 1;
					sendAlert("Address access denied, connection closed :(");

					if (socket) {
						socket.close(1000, "User denied GetAddress");
						socket = null;
					}
					daemonEndpoint = null;
					indexRequested = false;

					return;
				}
				// CATCH GETDAEMON DENIAL
				if (data.id && String(data.id).includes("get-daemon-endpoint")) {
					console.log("%cUser denied node access, closing connection..", "color: red");

					sendAlert("Node access denied. Closing connection..");

					// Full clean shutdown
					if (daemonGraceTimeout) clearTimeout(daemonGraceTimeout);
					if (txTrackerInterval) clearInterval(txTrackerInterval);
					
					myAddress = "";
					daemonEndpoint = null;
					daemonEndpointRequested = false;
					daemonReady = false;
					pendingTXID = null;
					indexRequested = false;

					if (MainVMi) {
						MainVMi.boolean("State.WaitingOnTX").value = false;
					}

					closeSocket();
					return;
				}

				sendAlert("Wallet error :(");
				MainVMi.boolean("State.WaitingOnTX").value = false;
				return;
			}

        } catch (e) {
            console.error("JSON parse failed:", e, event.data);
        }
    };

    socket.onerror = () => sendAlert("Cannot reach wallet. Is it running?");
    socket.onclose = (e) => {
        console.log("Wallet socket closed:", e.code);
        socket = null;
        MainVMi.number("State.Connect").value = 1;
        if (e.code !== 1000) sendAlert("Connections lost");
    };
}
window.connectWebSocket = connectWebSocket;

// AVATAR LOAD HANDLER
function handleAvatarLoadResponse(data) {
    const currentAddress = myAddress;
    if (!currentAddress) {
        console.log("No address, cannot load avatar!");
        return;
    }

    const stringkeys = data.result?.stringkeys || {};
    const key = "avatar_" + currentAddress;

    let avatarString = stringkeys[key];

    if (!avatarString) {
        console.log("No avatar found on chain:", key);
        if (MainVMi) MainVMi.boolean("State.UserAvatarExists").value = false;
        return;
    }

    // Decode from HEX now (must be exactly 1152)
    if (avatarString.length === 1152 && /^[0-9a-fA-F]{1152}$/.test(avatarString)) {
        console.log("Decoding Villager HEX...");
        avatarString = hexToString(avatarString);
        console.log("%cDecoded to 576 chars", "color: lime");
    }

    // Check after decode, must be exactly 576
    if (avatarString.length === 576) {
        if (!isValidAvatarString(avatarString)) {
            console.error("Loaded avatar contains invalid characters");
            sendAlert("Avatar corrupted on chain!");
            return;
        }
        console.log("%cVillager loaded! Sending to canvas...", "color: lime");
        setArtString(avatarString);
        sendAlert("Your Villager has materialized!");

        if (MainVMi) {
            MainVMi.boolean("State.UserAvatarExists").value = true;
        }
    } else {
        console.error("%cFATAL: Avatar corrupted on chain :(. Try re-saving a new one!", "color: red", {
            key,
            rawLength: stringkeys[key]?.length,
            finalLength: avatarString.length,
            preview: avatarString.substring(0, 100)
        });
        sendAlert("Avatar corrupted on chain!");
    }
}

// REFRESH AVATARS FOR GALLERY
window.refreshAvatars = function() {
    return new Promise((resolve) => {
        indexResolve = resolve;
        getVillagerIndex();
    });
};

// GET GAS ESTIMATE FOR STORAGE
async function getGasEstimateForAvatarStore() {
    if (!daemonReady) {
        sendAlert("Node connection required");
        return { fees: 1261 };
    }

    const currentAddress = myAddress;
    if (!currentAddress) return { fees: 1261 };

    const avatarString = generateArtString();
    if (avatarString.length !== 576) return { fees: 1261 };

    const requestId = "gas-" + Date.now();

    const payload = {
        jsonrpc: "2.0",
        id: requestId,
        method: "DERO.GetGasEstimate",
        params: {
            signer: currentAddress,
            ringsize: 2,
			scid: villager_scid,
            transfers: [{
				destination: "dero1qytqjd4ut5wl0rkueju9lq8xq5n0rev9xg9wcxue9rnj7z6umgr5vqgk8xzhj",
				amount: 0,
				burn: storeDevFee
			}],
            sc_rpc: [
			
                { name: "SC_ACTION", datatype: "U", value: 0 },
                { name: "entrypoint", datatype: "S", value: "StoreAvatar" },
				{ name: "SC_ID", datatype: "H", value: villager_scid },
                { name: "avatar", datatype: "S", value: avatarString }
            ]
        }
    };

    return new Promise((resolve) => {
        const handler = (e) => {
            try {
                const data = JSON.parse(e.data);
                if (data.id !== requestId) return;

                daemonSocket.removeEventListener("message", handler);

                if (data.error) {
                    console.error("Gas estimate failed:", data.error);
                    resolve({ fees: 5000 });
                    return;
                }

                const gasStorage = data.result?.gasstorage || 0;
                const gasCompute = data.result?.gascompute || 0;
                const recommendedFees = gasStorage;
				

                console.log("%cGas estimate OK", "color: lime", {
                    gasStorage, gasCompute, fees: recommendedFees
                });
				console.log(`Total cost to store, including dev donation = ${recommendedFees + storeDevFee} DERI`)
                sendAlert(`Fee: ${recommendedFees} DERO`);
                resolve({ fees: recommendedFees + 150 }); // Add buffer for additional storage

            } catch (err) {
                console.error("Parse error:", err);
                daemonSocket.removeEventListener("message", handler);
                resolve({ fees: 5000 });
            }
        };

        daemonSocket.addEventListener("message", handler);
        console.log("%cSending GetGasEstimate...", "color: gold");
        sendToDaemon(payload);

    });
}



// HEX TO STRING
function hexToString(hex) {
    let str = '';
    for (let i = 0; i < hex.length; i += 2) {
        str += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
    }
    return str;
}

// CLEAN DISCONNECT
function closeSocket() {
    if (socket) {
        socket.close(1000, "User requested");
        socket = null;
    }
    if (daemonSocket) {
        daemonSocket.close(1000, "Wallet disconnected");
        daemonSocket = null;
    }
    myAddress = "";
    daemonEndpoint = null;
    daemonEndpointRequested = false;
	daemonSocket = null;
	daemonReady = false;
    pendingTXID = null;
	indexRequested = false;
    triedWS = false;
    if (txTrackerInterval) clearInterval(txTrackerInterval);

    if (MainVMi) {
        MainVMi.number("State.Connect").value = 1;
        sendAlert("Disconnected, coming back?");
    }
}
window.closeSocket = closeSocket;

// SEND DATA CALL TO WALLET
function sendData(obj) {
    if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(obj));
    } else {
        console.warn("Wallet socket not open, cannot transact!", obj);
    }
}

// FETCH INDEX FROM VILLAGE SC
function getVillagerIndex() {
    if (indexRequested) {
        console.log("Index already being fetched, please wait...");
        return;
    }
    indexRequested = true;

    if (daemonSocket?.readyState === WebSocket.OPEN && daemonReady) {
        console.log("%cNode connection good, refreshing Village index", "color: lime");
        sendDaemonGetSC("index");
        return;
    }

    if (daemonEndpoint) {
        console.log("%cNode endpoint known, connecting & waiting...", "color: cyan");
        connectToDaemon();
        startDaemonGracePeriod();
        return;
    }

    // No daemon, no endpoint, wait for user to allow
    console.log("%cNo node endpoint, waiting for user approval...", "color: orange");
    startDaemonGracePeriod();
}

// SEND DERO.GetSC REQUEST TO DAEMON
function sendDaemonGetSC(type = "index") {
    const id = type === "index" 
        ? "villager-index-daemon-" + Date.now()
        : "load-avatar-daemon-" + Date.now();

    sendToDaemon({
        jsonrpc: "2.0",
        id: id,
        method: "DERO.GetSC",
        params: {
            scid: villager_scid,
            variables: true,
            code: false
        }
    });
}

// Starts the 15-second grace period
function startDaemonGracePeriod() {
    if (daemonGraceTimeout) clearTimeout(daemonGraceTimeout);

    daemonGraceTimeout = setTimeout(() => {
        console.log("%cNode connection timed out and is required, shutting down.", "color: red");
        sendAlert("Node access required. Connection closed.");

        // Full reset
        if (txTrackerInterval) clearInterval(txTrackerInterval);
        daemonEndpoint = null;
        daemonEndpointRequested = false;
        daemonReady = false;
        pendingTXID = null;
        indexRequested = false;

        if (MainVMi) {
            MainVMi.boolean("State.WaitingOnTX").value = false;
        }

        closeSocket();
    }, 15000);
}

// LOAD AVATAR FROM CHAIN (via node)
function loadAvatarFromChain() {
    if (daemonSocket?.readyState === WebSocket.OPEN && daemonReady) {
        console.log("%cLoading villager from node...", "color: magenta");
        sendDaemonGetSC("avatar");
        return;
    }

    console.log("%cCannot load avatar, no daemon connection", "color: red; font-weight: bold");
    sendAlert("No node connection, allow daemon access.");
    
    // Force reconnect
    setTimeout(() => closeSocket(), 3000);
}

// REGISTER ACCOUNT ON-CHAIN
function registerAccount() {
	if (!daemonReady) {
        sendAlert("Node connection required to register");
        return;
    }
    const currentAddress = myAddress;

    if (!currentAddress) {
        sendAlert("Connect wallet first!");
        return;
    }

    console.log("Registering account for:", ".." + currentAddress.slice(-8));

    const call = {
        jsonrpc: "2.0",
        id: "register-" + Date.now(),
        method: "scinvoke",
        params: {
            scid: villager_scid.trim(),
            ringsize: 2,
            sc_rpc: [
                { name: "entrypoint", datatype: "S", value: "RegisterAccount" }
            ]
        }
    };

    sendData(call);
	MainVMi.boolean("State.WaitingOnTX").value = true;
    sendAlert("Register request sent... (check wallet)");
}
window.registerAccount = registerAccount;

// UNREGISTER ACCOUNT
function unregisterAccount() {
	if (!daemonReady) {
        sendAlert("Node connection required");
        return;
    }
    const currentAddress = myAddress;

    if (!currentAddress) {
        sendAlert("Connect wallet first!");
        return;
    }

    console.log("Unregistering account for:", ".." + currentAddress.slice(-8));

    const call = {
        jsonrpc: "2.0",
        id: "unregister-" + Date.now(),
        method: "scinvoke",
        params: {
            scid: villager_scid.trim(),
            ringsize: 2,
            sc_rpc: [
                { name: "entrypoint", datatype: "S", value: "UnRegisterAccount" }
            ]
        }
    };

    sendData(call);
	MainVMi.boolean("State.WaitingOnTX").value = true;
    sendAlert("Unregister request sent... (check wallet)");
}
window.unregisterAccount = unregisterAccount;

// STORE AVATAR ON-CHAIN
async function storeAvatarOnChain() {
    if (!myAddress) {
        sendAlert("Connect wallet first!");
        return;
    }

    if (!daemonReady) {
        sendAlert("Node connection required to save avatar");
        return;
    }

    sendAlert("Estimating fee...");
    const estimate = await getGasEstimateForAvatarStore();
    const fees = estimate?.fees || 1261;

    const avatarString = generateArtString();
    if (avatarString.length !== 576) {
        sendAlert("Avatar corrupted!");
        return;
    }
    if (!isValidAvatarString(avatarString)) {
        sendAlert("Avatar contains invalid characters!");
        return;
    }

    const currentAddress = myAddress;

    const call = {
        jsonrpc: "2.0",
        id: "store-avatar-" + Date.now(),
        method: "transfer",
		params: {
		transfers: [{
			destination: "dero1qyqqtsvggrfxtsz6p3yn49n26k83nnr50jmpnyqylykzju4wgl9yvqqdxdvse",
			amount: 0,
			burn: storeDevFee
		}],	
		ringsize: 2,
		scid: villager_scid,
		fees: fees,
		sc_rpc: [
                { name: "entrypoint",	datatype: "S", value: "StoreAvatar" },
                { name: "avatar",		datatype: "S", value: avatarString }
            ]
        }
    };

    console.log("%cSending SC call", "color: cyan", call);
    sendData(call);
    sendAlert(`Saving, check wallet! (STORE FEE: ${fees + storeDevFee} DERI)`);
	MainVMi.boolean("State.WaitingOnTX").value = true;
}

// HANDLE GETSC RESPONSE
function handleGetSCResponse(data) {
    const currentAddress = myAddress;

    if (!currentAddress) {
        console.error("No address available");
        if (MainVMi) {
            MainVMi.boolean("State.UserIsRegistered").value = false;
            MainVMi.boolean("State.UserAvatarExists").value = false;
        }
        return;
    }

    const stringKeys = data.result?.stringkeys || {};
    const uint64Keys = data.result?.uint64keys || {};
    const registeredKey = "registered_" + currentAddress;
    const avatarKey = "avatar_" + currentAddress;

    const isRegistered = stringKeys.hasOwnProperty(registeredKey);
    const hasAvatar = stringKeys.hasOwnProperty(avatarKey);

    // Count actual stored avatars
    let avatarCount = 0;
    for (const key in stringKeys) {
        if (key.startsWith("avatar_") && typeof stringKeys[key] === "string" && stringKeys[key].length > 0) {
            avatarCount++;
        }
    }

    // SC owner validation
    const ownerHex = data.result?.stringkeys?.owner ?? null;

    if (!ownerHex) {
        console.error("%cFATAL: SC owner key missing, possible spoofed or uninitialized contract!", "color: red");
        sendAlert("Warning: Corrupted SC detected!");
        return;
    }

    let ownerAddress;
    try {
        ownerAddress = hexToString(ownerHex.trim());
    } catch (e) {
        console.error("%cFailed to decode owner hex string from SC", "color: red", ownerHex);
        sendAlert("Warning: Corrupted SC detected!");
        return;
    }

    if (ownerAddress !== valid_sc_owner) {
        console.error("%cSECURITY ALERT: Wrong SC owner!", "color: red");
        console.error("Expected:", valid_sc_owner);
        console.error("Got:     ", ownerAddress);
        console.error("Raw hex: ", ownerHex);
        sendAlert("Warning: Corrupted SC detected!");
        return;
    }

    // Owner validated, safe to trust this SC
    storeDevFee = data.result?.stringkeys?.devFee ?? null;
    console.log("%cOfficial Villager SC confirmed, Owner:", "color: lime", ownerAddress);
    console.log("%cSCID:", "color: lime", villager_scid);
    console.log("Suggested devFee/donation (not SC enforced):", storeDevFee);

    // Population & Avatar Stats
    const population = stringKeys.population ?? "unknown";

    console.log("%c=== VILLAGER INDEX STATS ===", "color: cyan; font-weight: bold");
    console.log("• Total registered accounts :", population);
    console.log("• Accounts with stored avatar :", avatarCount, `(out of ${population})`);
    console.log("• Your account registered     :", isRegistered ? "YES" : "NO");
    console.log("• You have a Villager        :", hasAvatar ? "YES" : "NO");
	
	// Collect stored avatars (after validation)
	window.storedAvatars = {};
	window.avatarTimestamps = {};
	for (const key in stringKeys) {
		if (key.startsWith("avatar_") && typeof stringKeys[key] === "string" && stringKeys[key].length > 0) {
			let avatarStr = stringKeys[key];
			// Decode hex
			if (avatarStr.length === 1152 && /^[0-9a-fA-F]{1152}$/.test(avatarStr)) {
				avatarStr = hexToString(avatarStr);
			}
			if (avatarStr.length === 576 && isValidAvatarString(avatarStr)) {
				const address = key.substring(7);  // After "avatar_"
				window.storedAvatars[address] = avatarStr;
				window.avatarTimestamps[address] = parseInt(hexToString(stringKeys["timestamp_" + address] || "0")) || 0;
			} else if (avatarStr.length === 576) {
				// Silently discard invalid avatar strings
				console.warn(`Discarding invalid avatar for address: ${key.substring(7)}`);
			}
		}
	}
	if (window.avatarCache) {
		window.avatarCache.forEach(url => URL.revokeObjectURL(url));
		window.avatarCache.clear();
		console.log("%cAvatar image cache cleared.", "color: lime");
	}
	if (indexResolve) {
		indexResolve();
		indexResolve = null;
	}
	console.log("%cStored avatars collected for gallery:", "color: lime", Object.keys(window.storedAvatars).length);
	
    // Update Rive state machine
    if (MainVMi) {
        try {
            MainVMi.boolean("State.UserIsRegistered").value = isRegistered;
            MainVMi.boolean("State.UserAvatarExists").value = hasAvatar;
        } catch (e) {
            console.error("Failed to update Rive state:", e);
        }
    }

    // Show stats to user
    setTimeout(() => {
        sendAlert(`Population: ${avatarCount} Villagers / ${population} Registrations`);
    }, 2000);

    // Allow new requests
    indexRequested = false;
}