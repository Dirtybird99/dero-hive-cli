/*
villager-identicon.js
Official Villager identicon renderer for HOLOGRAM.

Mainnet SCID: f0b29081c1ed35fe942cb3402cd9d7bf0cf27639201bbc96223bdc99c4c6aa9f

How developers can fetch the avatar data:
──────────────────────────────────────────────────────────────
// 1. Connect to any DERO daemon WebSocket (public or private node)
const socket = new WebSocket("http://ip:10102/ws"); // or your own node endpoint acquired from XSWD
──────────────────────────────────────────────────────────────
// Call example (get all avatars)
method: "DERO.GetSC",
params: {
scid: "f0b29081c1ed35fe942cb3402cd9d7bf0cf27639201bbc96223bdc99c4c6aa9f",
variables: true,
code: false
}

// Response handler example (for all avatars/identicons)
for (const key in stringKeys) {
	if (key.startsWith("avatar_") && typeof stringKeys[key] === "string" && stringKeys[key].length > 0) {
		let avatarStr = stringKeys[key];
		// Avatars are stored as hex strings in the SC, decode to 576-char string
		avatarStr = hexToString(avatarStr);
		const address = key.substring(7);  // After "avatar_"
		window.storedAvatars[address] = avatarStr;
		// Block heights are stored as hex strings, decode to number
		const blockHeightHex = stringKeys[`timestamp_${address}`] || '0';
		window.avatarTimestamps[address] = parseInt(blockHeightHex, 16);
	}
}
──────────────────────────────────────────────────────────────
// Alternative: Get single avatar/identicon string
method: "DERO.GetSC",
params: {
scid: "f0b29081c1ed35fe942cb3402cd9d7bf0cf27639201bbc96223bdc99c4c6aa9f",
keysstring: ["avatar_dero1qyre7td6x9r88y4cavdgpv6k7lvx6j39lfsx420hpvh3ydpcrtxrxqga4mp52"] // Replace with target address
}

// Alternative: Handle single avatar response
const avatarStr = data.result.valuesstring[0];
if (avatarStr) {
    // Avatars are stored as hex strings in the SC, decode to 576-char string
    const decodedAvatar = hexToString(avatarStr);
    window.storedAvatars[targetAddress] = decodedAvatar;
    // Block heights are stored as hex strings, decode to number
    const blockHeightHex = data.result.valuesstring[1] || '0'; // Assuming second value is block height
    window.avatarTimestamps[targetAddress] = parseInt(blockHeightHex, 16);
}
──────────────────────────────────────────────────────────────

Library usage:
──────────────────────────────────────────────────────────────
  <script src="villager-identicon.js"></script>

  // Common sizes:
  await VillagerIdenticon.render(addr, hex, 180);  // thumbnail
  await VillagerIdenticon.render(addr, hex, 512);  // profile
  await VillagerIdenticon.render(addr, hex, 800);  // full view

  // Always revoke when done:
  URL.revokeObjectURL(url);

  // Clear all cached images as often as possible, when they aren't in use.
  // Remember to call URL.revokeObjectURL(url) when the image is no longer needed, for memory safety.
  VillagerIdenticon.clearCache();
──────────────────────────────────────────────────────────────
*/

const VillagerIdenticon = (function () {
	const avatarCache = new Map();
    // ──────────────────────────────────────────────────────────────
    // 1. Official Villager palette (must never change)
    // ──────────────────────────────────────────────────────────────
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

    // ──────────────────────────────────────────────────────────────
    // 2. Validation constants
    // ──────────────────────────────────────────────────────────────
    const VALID_PALETTE_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    const VALID_CHARS_SET = new Set(VALID_PALETTE_CHARS);

    // ──────────────────────────────────────────────────────────────
    // 3. Validation functions
    // ──────────────────────────────────────────────────────────────
    function isValidAvatarString(str) {
        return validateAvatarString(str).valid;
    }

    function sanitizeAvatarString(str) {
        if (!str || typeof str !== 'string') return 'z'.repeat(576);
        
        let result = '';
        for (let i = 0; i < 576; i++) {
            const c = str[i];
            result += (c && VALID_CHARS_SET.has(c)) ? c : 'z';
        }
        return result;
    }

    function validateAvatarString(str) {
        const result = {
            valid: true,
            length: str?.length || 0,
            expectedLength: 576,
            invalidChars: [],
            invalidPositions: []
        };
        
        if (!str || typeof str !== 'string') {
            result.valid = false;
            return result;
        }
        
        if (str.length !== 576) {
            result.valid = false;
        }
        
        for (let i = 0; i < str.length; i++) {
            if (!VALID_CHARS_SET.has(str[i])) {
                result.valid = false;
                if (!result.invalidChars.includes(str[i])) {
                    result.invalidChars.push(str[i]);
                }
                result.invalidPositions.push(i);
            }
        }
        
        return result;
    }

    // ──────────────────────────────────────────────────────────────
    // 2. Fast deterministic 32-bit hash
    // ──────────────────────────────────────────────────────────────
    function simpleHash(str) {
        let h = 1779033703 ^ str.length;
        for (let i = 0; i < str.length; i++) {
            h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
            h = h << 13 | h >>> 19;
        }
        return h >>> 0;
    }

    // ──────────────────────────────────────────────────────────────
    // 3. Hex → 576-char string
    // ──────────────────────────────────────────────────────────────
    function hexToString(hex) {
        if (hex.length !== 1152 || !/^[0-9a-fA-F]{1152}$/.test(hex)) {
            throw new Error("Invalid hex string – must be exactly 1152 hex chars");
        }
        let str = '';
        for (let i = 0; i < hex.length; i += 2) {
            str += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
        }
        return str;
    }

	// ──────────────────────────────────────────────────────────────
    // 4. Render Controller
    // ──────────────────────────────────────────────────────────────
    async function renderSmart(address, rawHexOrString, requestedSize = 180) {
        let avatarStr = rawHexOrString;
        if (typeof avatarStr === 'string' && avatarStr.length === 1152 && /^[0-9a-fA-F]{1152}$/.test(avatarStr)) {
            avatarStr = hexToString(avatarStr);
        }

        if (avatarStr.length !== 576) {
            throw new Error("Avatar must be 576 characters after decoding");
        }

        const cacheKey = address;

        // Cache the full 800px version once
        if (!avatarCache.has(cacheKey)) {
            const fullUrl = await generateAvatarWithFrame(address, avatarStr, 800);
            avatarCache.set(cacheKey, fullUrl);
        }

        const fullUrl = avatarCache.get(cacheKey);

        // Return full size if requested
        if (requestedSize >= 800) {
            return fullUrl;
        }

        // Otherwise, scale down
        return new Promise(resolve => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = requestedSize;
                canvas.height = requestedSize;
                const ctx = canvas.getContext('2d');
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = 'high';
                ctx.drawImage(img, 0, 0, requestedSize, requestedSize);
                canvas.toBlob(blob => resolve(URL.createObjectURL(blob)), 'image/png');
            };
            img.src = fullUrl;
        });
    }

    // ──────────────────────────────────────────────────────────────
    // 4. Core renderer
    // ──────────────────────────────────────────────────────────────
	async function generateAvatarWithFrame(address, avatarStr, size = 180) {
		if (avatarStr.length !== 576) return Promise.reject("Invalid avatar string");
		if (!isValidAvatarString(avatarStr)) return Promise.reject("Invalid avatar characters");

		console.log(`generating Villager Identicon for address: ${address}`);

		const uniquePart = address.startsWith('dero1') ? address.slice(5) : address;
		const frameSeed = simpleHash(uniquePart + "FRAME");
		const bgSeed   = simpleHash(uniquePart + "BACKGROUND");

		const renderSize = 800;
		const canvas = document.createElement('canvas');
		const ctx = canvas.getContext('2d');
		canvas.width = renderSize;
		canvas.height = renderSize;

		const border = Math.floor(renderSize * 0.13);
		const inner = renderSize - 2 * border;

		// Varied gradient background
		const gradType = bgSeed % 4;
		const cx = renderSize / 2 + (simpleHash(uniquePart + "CX") % 50 - 25);
		const cy = renderSize / 2 + (simpleHash(uniquePart + "CY") % 50 - 25);

		let grad;
		if (gradType === 0) {
			grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, renderSize * 1.2);
			grad.addColorStop(0, `hsl(${bgSeed % 360}, 100%, 45%)`);
			grad.addColorStop(0.2, `hsl(${((bgSeed + 45) % 360)}, 98%, 38%)`);
			grad.addColorStop(0.4, `hsl(${(bgSeed + 90) % 360}, 95%, 30%)`);
			grad.addColorStop(0.6, `hsl(${(bgSeed + 135) % 360}, 90%, 22%)`);
			grad.addColorStop(0.8, `hsl(${(bgSeed + 170) % 360}, 87%, 16%)`);
			grad.addColorStop(1, `hsl(${(bgSeed + 200) % 360}, 85%, 12%)`);
		} else if (gradType === 1) {
			grad = ctx.createLinearGradient(0, 0, renderSize, renderSize);
			grad.addColorStop(0, `hsl(${bgSeed % 360}, 100%, 40%)`);
			grad.addColorStop(0.5, `hsl(${((bgSeed + 75) % 360)}, 95%, 27%)`);
			grad.addColorStop(1, `hsl(${((bgSeed + 150) % 360)}, 90%, 15%)`);
		} else if (gradType === 2) {
			grad = ctx.createRadialGradient(cx, cy, renderSize * 0.05, cx, cy, renderSize);
			grad.addColorStop(0, `hsl(${((bgSeed + 130) % 360)}, 100%, 55%)`);
			grad.addColorStop(0.25, `hsl(${(((bgSeed + 65) % 360))}, 100%, 42%)`);
			grad.addColorStop(0.5, `hsl(${bgSeed % 360}, 100%, 28%)`);
			grad.addColorStop(0.75, `hsl(${((bgSeed + 110) % 360)}, 90%, 18%)`);
			grad.addColorStop(1, `hsl(${((bgSeed + 220) % 360)}, 80%, 12%)`);
		} else {
			grad = ctx.createConicGradient(bgSeed * 0.008, renderSize/2, renderSize/2);
			grad.addColorStop(0, `hsl(${bgSeed % 360}, 95%, 55%)`);
			grad.addColorStop(0.16, `hsl(${((bgSeed + 15) % 360)}, 90%, 50%)`);
			grad.addColorStop(0.33, `hsl(${((bgSeed + 30) % 360)}, 85%, 42%)`);
			grad.addColorStop(0.5, `hsl(${((bgSeed + 45) % 360)}, 75%, 35%)`);
			grad.addColorStop(0.66, `hsl(${((bgSeed + 60) % 360)}, 65%, 30%)`);
			grad.addColorStop(0.83, `hsl(${(bgSeed + 75) % 360}, 60%, 28%)`);
			grad.addColorStop(1, `hsl(${bgSeed % 360}, 95%, 55%)`);
		}
		ctx.fillStyle = grad;
		ctx.fillRect(0, 0, renderSize, renderSize);

		// Tiny starfield
		for (let i = 0; i < renderSize/2; i++) {
			const x = simpleHash(uniquePart + i) % renderSize;
			const y = simpleHash(uniquePart + i + 7777) % renderSize;
			const b = 40 + (simpleHash(uniquePart + i + 99999) % 60);
			const starSize = 1 + (simpleHash(uniquePart + i + 22222) % 2);
			ctx.fillStyle = `hsl(70, 40%, ${b}%)`;
			ctx.fillRect(x, y, starSize, starSize);
		}

		// Frame styles
		const hueBase = frameSeed % 360;
		const shapeType = frameSeed % 5;
		const rotation = (frameSeed % 91) - 45;

		ctx.save();
		ctx.translate(renderSize / 2, renderSize / 2);
		ctx.rotate(rotation * Math.PI / 180);

		if (shapeType === 0) { // Polygon shards
			const sides = 3 + (simpleHash(uniquePart + "SIDES") % 4);
			const distortFactor = 3 + (simpleHash(uniquePart + "DISTORT") % 20);
			const layerOffset = (simpleHash(uniquePart + "LAYER_OFFSET") % 360) * Math.PI / 180;
			for (let l = 4; l >= 1; l--) {
				ctx.shadowColor = 'rgba(0,0,0,0.4)';
				ctx.shadowBlur = border * 0.15;
				ctx.shadowOffsetX = border * 0.05;
				ctx.shadowOffsetY = border * 0.05;
				ctx.fillStyle = `hsla(${(hueBase + l*72 + (simpleHash(uniquePart + l) % 60) - 30)%360},90%,66%,0.25)`;
				ctx.beginPath();
				const layerRot = layerOffset + l * 0.5;
				for (let i = 0; i <= sides; i++) {
					const a = i / sides * Math.PI * 2 + layerRot;
					const r = inner/2 + border*0.75*(l/4) + Math.cos(a*distortFactor + l)*border*0.25;
					const x = Math.cos(a) * r;
					const y = Math.sin(a) * r;
					i===0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
				}
				ctx.closePath();
				ctx.fill();
			}
			ctx.shadowColor = 'transparent';
			ctx.shadowBlur = 0;
			ctx.shadowOffsetX = 0;
			ctx.shadowOffsetY = 0;
		} else if (shapeType === 1) { // Crystal Shards
			const shardCount = 4 + (simpleHash(uniquePart + "SHARD_COUNT") % 10);
			const angleOffset = (simpleHash(uniquePart + "SHARD_OFFSET") % 360) * Math.PI / 180;
			// Calculate outermost nebula ring radius for attachment
			const nebulaRingCount = 5 + (simpleHash(uniquePart + "RING_COUNT") % 5);
			const nebulaRadiusVar = 0.2 + (simpleHash(uniquePart + "RING_RADIUS") % 50) / 100;
			const outermostNebulaR = inner/2 + border * (0.1 + nebulaRadiusVar);
			for (let i = 0; i < shardCount; i++) {
				const a = angleOffset + (i / shardCount) * Math.PI * 2;
				const dist = (outermostNebulaR + border * ((simpleHash(uniquePart + i) % 40) / 100 - 0.2)) * 0.5;
				const size = border * (1.0 + (simpleHash(uniquePart + i + 1000) % 100) / 100);
				const x = Math.cos(a) * dist;
				const y = Math.sin(a) * dist;
				ctx.save();
				ctx.translate(x, y);
				ctx.rotate(a);
				// Radial gradient from tip for spotlight effect
				const grad = ctx.createRadialGradient(size, 0, 0, size, 0, size);
				const hue = hueBase + (simpleHash(uniquePart + i + 2000) % 60) - 30;
				grad.addColorStop(0, `hsla(${hue},90%,70%,0.8)`);
				grad.addColorStop(1, `hsla(${hue},90%,70%,0)`);
				ctx.fillStyle = grad;
				// Add shadow for depth
				ctx.shadowColor = `hsla(${hue},90%,70%,0.5)`;
				ctx.shadowBlur = size * 0.3;
				ctx.shadowOffsetX = size * 0.1;
				ctx.shadowOffsetY = size * 0.1;
				ctx.beginPath();
				ctx.moveTo(size, 0);
				ctx.lineTo(0, -size * 0.5);
				ctx.lineTo(0, size * 0.5);
				ctx.closePath();
				ctx.fill();
				// Add burst line from tip outward
				ctx.strokeStyle = `hsla(${hue},90%,70%,0.6)`;
				ctx.lineWidth = border * 0.03;
				ctx.lineCap = 'round';
				const extension = border * 0.6;
				ctx.beginPath();
				ctx.moveTo(size, 0);
				ctx.lineTo(size + extension, 0);
				ctx.stroke();
				// Add small cube at the end
				ctx.fillStyle = `hsla(${hue},90%,70%,1.0)`;
				const cubeSize = border * 0.04;
				ctx.fillRect(size + extension - cubeSize/2, -cubeSize/2, cubeSize, cubeSize);
				ctx.restore();
			}
		} else if (shapeType === 2) { // Glitch rings
			const ringCount = 4 + (simpleHash(uniquePart + "GLITCH_COUNT") % 7);
			const colorStep = 30 + (simpleHash(uniquePart + "GLITCH_COLOR") % 60);
			const dashBase = 12 + (simpleHash(uniquePart + "GLITCH_DASH") % 24);
			const offsetVar = (simpleHash(uniquePart + "GLITCH_OFFSET") % 100) - 50;
			for (let i = ringCount; i >= 1; i--) {
				const r = inner/2 + border * (0.2 + (simpleHash(uniquePart + i) % 80) / 100) * (i / ringCount);
				const hueShift = (hueBase + i * colorStep + (simpleHash(uniquePart + i + 1000) % 60) - 30) % 360;
				ctx.shadowColor = 'rgba(0,0,0,0.4)';
				ctx.shadowBlur = border * 0.1;
				ctx.shadowOffsetX = border * 0.03;
				ctx.shadowOffsetY = border * 0.03;
				ctx.strokeStyle = `hsla(${hueShift},95%,74%,0.7)`;
				ctx.lineWidth = 6 + (simpleHash(uniquePart + i + 2000) % 12);
				const dashLen = dashBase + (simpleHash(uniquePart + i + 3000) % 30) - 15;
				const gapLen = 6 + (simpleHash(uniquePart + i + 4000) % 18);
				ctx.setLineDash([dashLen, gapLen]);
				ctx.lineDashOffset = offsetVar + (simpleHash(uniquePart + i + 5000) % 100) - 50;
				ctx.beginPath();
				const startAngle = (simpleHash(uniquePart + i + 6000) % 360) * Math.PI / 180;
				const arcLength = (0.5 + (simpleHash(uniquePart + i + 7000) % 50) / 100) * Math.PI * 2;
				ctx.arc(0, 0, r, startAngle, startAngle + arcLength);
				ctx.stroke();
			}
			ctx.setLineDash([]);
			ctx.shadowColor = 'transparent';
			ctx.shadowBlur = 0;
			ctx.shadowOffsetX = 0;
			ctx.shadowOffsetY = 0;
		} else if (shapeType === 3) { // Crystal grid
			const count = 2 + (simpleHash(uniquePart + "CRYSTAL_COUNT") % 4);
			for (let i = 0; i < count; i++) {
				const a = i / count * Math.PI * 2;
				const h = (hueBase + i*30) % 360;
				ctx.shadowColor = 'rgba(0,0,0,0.4)';
				ctx.shadowBlur = border * 0.12;
				ctx.shadowOffsetX = border * 0.04;
				ctx.shadowOffsetY = border * 0.04;
				ctx.fillStyle = `hsla(${h},92%,68%,0.3)`;
				ctx.beginPath();
				for (let j = 0; j < 6; j++) {
					const r = inner/2 + border*0.7;
					const rotVar = (simpleHash(uniquePart + i + j) % 60 - 30) * Math.PI / 180;
					const a2 = a + j/6*Math.PI*2 + rotVar;
					const x = Math.cos(a2) * r;
					const y = Math.sin(a2) * r * 0.7;
					j===0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
				}
				ctx.closePath();
				ctx.fill();
				// Add burst lines from vertices outward
				ctx.strokeStyle = `hsla(${h},92%,68%,0.6)`;
				ctx.lineWidth = border * 0.03;
				ctx.lineCap = 'round';
				for (let j = 0; j < 6; j++) {
					const r = inner/2 + border*0.7;
					const rotVar = (simpleHash(uniquePart + i + j) % 60 - 30) * Math.PI / 180;
					const a2 = a + j/6*Math.PI*2 + rotVar;
					const x = Math.cos(a2) * r;
					const y = Math.sin(a2) * r * 0.7;
					const x2 = Math.cos(a2) * (r + border * 0.6);
					const y2 = Math.sin(a2) * (r + border * 0.6) * 0.7;
					ctx.beginPath();
					ctx.moveTo(x, y);
					ctx.lineTo(x2, y2);
					ctx.stroke();
					// Add small cube at the end
					ctx.fillStyle = `hsla(${h},92%,68%,1.0)`;
					const cubeSize = border * 0.04;
					ctx.fillRect(x2 - cubeSize/2, y2 - cubeSize/2, cubeSize, cubeSize);
				}
			}
			ctx.shadowColor = 'transparent';
			ctx.shadowBlur = 0;
			ctx.shadowOffsetX = 0;
			ctx.shadowOffsetY = 0;
		} else { // Nebula rings
			const ringCount = 8 + (simpleHash(uniquePart + "RING_COUNT") % 8);
			const colorStep = 40 + (simpleHash(uniquePart + "RING_COLOR") % 40);
			const radiusVar = 0.2 + (simpleHash(uniquePart + "RING_RADIUS") % 50) / 100;
			const alphaBase = 0.3 + (simpleHash(uniquePart + "RING_ALPHA") % 40) / 100;
			for (let i = ringCount; i >= 1; i--) {
				const r = inner/2 + border * i / ringCount * (0.8 + radiusVar * 0.4);
				const hueShift = (hueBase + i * colorStep) % 360;
				ctx.strokeStyle = `hsla(${hueShift},88%,65%,${alphaBase * (i / ringCount)})`;
				ctx.lineWidth = border * (0.15 + (simpleHash(uniquePart + i) % 30) / 100);
				ctx.globalAlpha = 1;
				// Add shadow for depth
				ctx.shadowColor = `hsla(${hueShift},88%,65%,0.5)`;
				ctx.shadowBlur = border * 0.2;
				ctx.shadowOffsetX = border * 0.05;
				ctx.shadowOffsetY = border * 0.05;
				ctx.beginPath();
				const wave = Math.sin(i * 1.8 + (simpleHash(uniquePart + "RING_WAVE") % 360) * Math.PI / 180) * border * 0.2;
				ctx.arc(0, 0, r + wave, 0, Math.PI * 2);
				ctx.stroke();
			}
			ctx.globalAlpha = 1;
		}

		// Varied multi-layer glow ring
		const glowCount = 1 + (frameSeed % 3);
		const GLOW_HUE = simpleHash(uniquePart + "GLOW_HUE") % 360;
		const GLOW_VAR = simpleHash(uniquePart + "GLOW_VAR") % 30;
		const glowHue = (hueBase + 100 + (frameSeed >> 5) % 140 + GLOW_HUE) % 360;
		for (let g = 0; g < glowCount; g++) {
			const offset = g * border * 0.09;
			const blur = border * (0.32 + g * 0.16 + (frameSeed % 50)/120);
			const width = border * (0.08 + g * 0.06);
			ctx.shadowBlur = blur;
			ctx.shadowColor = `hsla(${glowHue + g*45 + (simpleHash(uniquePart + g) % GLOW_VAR)},100%,78%,0.92)`;
			ctx.strokeStyle = `hsla(${glowHue + g*55 + (simpleHash(uniquePart + g + 100) % GLOW_VAR)},100%,82%,1)`;
			ctx.lineWidth = width;
			ctx.beginPath();
			ctx.arc(0, 0, inner/2 + border*0.26 + offset, 0, Math.PI*2);
			ctx.stroke();
		}

		ctx.restore();

		// Subtle texture overlay on top of frame
		ctx.globalCompositeOperation = 'overlay';
		for (let i = 0; i < renderSize / 4; i++) {
			const x = simpleHash(uniquePart + "TEX" + i) % renderSize;
			const y = simpleHash(uniquePart + "TEX" + i + 10000) % renderSize;
			const gray = 100 + (simpleHash(uniquePart + "TEX" + i + 20000) % 55);
			ctx.fillStyle = `hsl(0, 0%, ${gray}%)`;
			ctx.fillRect(x, y, 1, 1);
		}
		ctx.globalCompositeOperation = 'source-over';

		// Universal glitch overlay effect
		ctx.save();
		ctx.translate(renderSize / 2, renderSize / 2);
		const glitchCount = 2 + (simpleHash(uniquePart + "GLITCH_OVERLAY") % 3);
		for (let g = 0; g < glitchCount; g++) {
			const r = inner/2 + border * (0.3 + (simpleHash(uniquePart + g) % 50) / 100);
			const hueShift = (bgSeed % 360 + (simpleHash(uniquePart + g + 1000) % 60) - 30) % 360;
			ctx.shadowColor = 'rgba(0,0,0,0.5)';
			ctx.shadowBlur = border * 0.15;
			ctx.shadowOffsetY = border * 0.05;
			ctx.strokeStyle = `hsla(${hueShift},100%,65%,0.6)`;
			ctx.lineWidth = 2 + (simpleHash(uniquePart + g + 2000) % 4);
			const dashLen = 8 + (simpleHash(uniquePart + g + 3000) % 16);
			const gapLen = 4 + (simpleHash(uniquePart + g + 4000) % 12);
			ctx.setLineDash([dashLen, gapLen]);
			ctx.lineDashOffset = (simpleHash(uniquePart + g + 5000) % 100) - 50;
			ctx.beginPath();
			const startAngle = (simpleHash(uniquePart + g + 6000) % 360) * Math.PI / 180;
			const arcLength = (0.3 + (simpleHash(uniquePart + g + 7000) % 40) / 100) * Math.PI;
			ctx.arc(0, 0, r, startAngle, startAngle + arcLength);
			ctx.stroke();
		}
		// Additional data-inspired concentric patterns
		for (let g = 0; g < glitchCount; g++) {
			const r = inner/2 + border * (0.5 + (simpleHash(uniquePart + g + 8000) % 30) / 100);
			const hueShift = (bgSeed % 360 + (simpleHash(uniquePart + g + 9000) % 60) - 30) % 360;
			ctx.strokeStyle = `hsla(${hueShift},100%,65%,0.5)`;
			ctx.lineWidth = 1;
			const dashLen = 4 + (simpleHash(uniquePart + g + 10000) % 8);
			const gapLen = 2 + (simpleHash(uniquePart + g + 11000) % 6);
			ctx.setLineDash([dashLen, gapLen]);
			ctx.lineDashOffset = (simpleHash(uniquePart + g + 12000) % 50) - 25;
			ctx.beginPath();
			ctx.arc(0, 0, r, 0, Math.PI * 2);
			ctx.stroke();
		}
		ctx.setLineDash([]);
		ctx.shadowColor = 'transparent';
		ctx.shadowBlur = 0;
		ctx.shadowOffsetY = 0;
		ctx.restore();

		// RENDER AVATAR
		const avatarCanvas = document.createElement('canvas');
		avatarCanvas.width = inner;
		avatarCanvas.height = inner;
		const actx = avatarCanvas.getContext('2d');
		actx.imageSmoothingEnabled = false;

		const CELL = inner / 24;
		const OVER = 1.0;

		let idx = 0;
		for (let x = 0; x < 24; x++) {
			for (let y = 0; y < 24; y++) {
				const ch = avatarStr[idx++];
				const argb = Char_To_Color[ch] || 0x00000000;
				const a = (argb >> 24) & 0xFF;
				if (a === 0) continue;

				const r = (argb >> 16) & 0xFF;
				const g = (argb >> 8)  & 0xFF;
				const b =  argb        & 0xFF;

				actx.fillStyle = `rgba(${r},${g},${b},${a/255})`;
				actx.fillRect(
					x * CELL - OVER/2,
					y * CELL - OVER/2,
					CELL + OVER,
					CELL + OVER
				);
			}
		}

		// Soft shadow under avatar
		ctx.shadowColor = 'rgba(0,0,0,0.7)';
		ctx.shadowBlur = border * 0.4;
		ctx.shadowOffsetY = border * 0.1;
		ctx.drawImage(avatarCanvas, border, border, inner, inner);

		ctx.shadowColor = 'transparent';

		// Subtle glassy overlay
		const overlayGrad = ctx.createRadialGradient(renderSize/2, renderSize/2, 0, renderSize/2, renderSize/2, renderSize * 0.8);
		overlayGrad.addColorStop(0, 'rgba(255,255,255,0.15)');
		overlayGrad.addColorStop(0.7, 'rgba(255,255,255,0.05)');
		overlayGrad.addColorStop(1, 'rgba(255,255,255,0)');
		ctx.fillStyle = overlayGrad;
		ctx.fillRect(0, 0, renderSize, renderSize);

		// Scale to requested size if different
		let finalCanvas = canvas;
		if (size !== renderSize) {
			const scaledCanvas = document.createElement('canvas');
			scaledCanvas.width = size;
			scaledCanvas.height = size;
			const sctx = scaledCanvas.getContext('2d');
			sctx.drawImage(canvas, 0, 0, size, size);
			finalCanvas = scaledCanvas;
		}

		return new Promise(resolve => {
			finalCanvas.toBlob(blob => resolve(URL.createObjectURL(blob)), 'image/png');
		});
	}
    // ──────────────────────────────────────────────────────────────
    // 5. Validation utilities (for defensive programming)
    // ──────────────────────────────────────────────────────────────
    
    return {
        render: renderSmart,
        clearCache: () => {
            avatarCache.forEach(url => URL.revokeObjectURL(url));
            avatarCache.clear();
        },
        // Validation utilities (Fix #2)
        isValid: isValidAvatarString,
        sanitize: sanitizeAvatarString,
        validate: validateAvatarString,
        // Expose palette info for external tools
        PALETTE_CHARS: VALID_PALETTE_CHARS,
        PALETTE: Char_To_Color
    };
})();

// ES6 export for module systems
export default VillagerIdenticon;

// Also make available globally for compatibility
if (typeof window !== 'undefined') {
    window.VillagerIdenticon = VillagerIdenticon;
}

