let canvas = document.getElementById("riveCanvas");
let r = null;
let lastPickerValue = null;
let MainVM, MainVMi, GridVM, GridVMi, PixelColorVM;
let pixelMap = new Map();
let User_ArtStringEntry;
let alertInterval = 0;
let alertMessage = null;
let checkCallStates = null;

const Blank_ArtString = ("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz");
const Default_ArtString = Blank_ArtString;

const Color_To_Char = {
  0xFFFF9999: '0', 0xFFFF6666: '1', 0xFFFF0000: '2', 0xFF800000: '3',
  0xFFFFA899: '4', 0xFFFF8C66: '5', 0xFFFF4500: '6', 0xFF802200: '7',
  0xFFFFC799: '8', 0xFFFFB266: '9', 0xFFFF8C00: 'A', 0xFF804600: 'B',
  0xFFFFE099: 'C', 0xFFFFD866: 'D', 0xFFFFAA00: 'E', 0xFF5C4033: 'F',
  0xFFFFFF99: 'G', 0xFFFFFF66: 'H', 0xFFFFFF00: 'I', 0xFFFFD700: 'J',
  0xFFCFFF99: 'K', 0xFFBFFF66: 'L', 0xFF80FF00: 'M', 0xFF408000: 'N',
  0xFF99FF99: 'O', 0xFF66FF66: 'P', 0xFF00FF00: 'Q', 0xFF008000: 'R',
  0xFF99FFCF: 'S', 0xFF66FFBF: 'T', 0xFF00FF80: 'U', 0xFF008040: 'V',
  0xFF99FFFF: 'W', 0xFF66FFFF: 'X', 0xFF00FFFF: 'Y', 0xFF008080: 'Z',
  0xFF99CFFF: 'a', 0xFF66BFFF: 'b', 0xFF0080FF: 'c', 0xFF004080: 'd',
  0xFF9999FF: 'e', 0xFF6666FF: 'f', 0xFF0000FF: 'g', 0xFF000080: 'h',
  0xFFCF99FF: 'i', 0xFFBF66FF: 'j', 0xFF8000FF: 'k', 0xFF400080: 'l',
  0xFFFF99FF: 'm', 0xFFFF66FF: 'n', 0xFFFF00FF: 'o', 0xFF800080: 'p',
  0xFFFF99C7: 'q', 0xFFFF66B2: 'r', 0xFFFF0080: 's', 0xFF800040: 't',
  0xFFFFFFFF: 'u', 0xFFB4B4B4: 'v', 0xFF848484: 'w', 0xFF434343: 'x',
  0xFF000000: 'y', 0x00000000: 'z'
};

function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.floor(window.innerWidth * dpr);
    const height = Math.floor(window.innerHeight * dpr);
    if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        canvas.style.width = window.innerWidth + 'px';
        canvas.style.height = window.innerHeight + 'px';
        if (r) r.resizeDrawingSurfaceToCanvas();
    }
}

window.addEventListener("DOMContentLoaded", () => {
  r = new rive.Rive({
    src: "villager-r3.riv",
    canvas: canvas,
    autoplay: true,
    stateMachines: "MainState",
    autoBind: false,
    layout: new rive.Layout({ fit: rive.Fit.Layout }),
    onLoad: () => {
      try {
        // Get view models
        MainVM       = r.viewModelByName("MainView");
        PixelColorVM = r.viewModelByName("Pixel.ColorVM");

        // Create main view model instance
        MainVMi = MainVM.defaultInstance();

        // Find artboard components
        const artboards = r.contents.artboards || [];
        const observerArtboard = artboards.find(ab => ab.name === "Observer");

        // Bind MainVMi to observer component
        if (observerArtboard) {
          r.bindViewModelInstance(MainVMi, observerArtboard);
        }

		// Populate pixels into grid
		const pixelList = MainVMi.viewModel("Grid").list("Pixel.List");
		const COLS = 24;
		const ROWS = 24;
		const TOTAL = 576;

		for (let i = 0; i < TOTAL; i++) {
		  const col = i % COLS;
		  const row = Math.floor(i / COLS);
		  const letter = String.fromCharCode(65 + row);
		  const number = col + 1;
		  const name = `${letter}${number}`;

		  const item = PixelColorVM.instance();
		  item.name = name;

		  const color = item.color("Color.Cell");
		  if (color) color.value = 0x00000000;

		  pixelList.addInstance(item);
		  pixelMap.set(name, item);
		}

		console.log("Pixel list length:", pixelList.length);
		console.log("Named pixels: A1 → X24 (576 total)");
		console.log("pixelMap built — name-based access ready");
		
		// Load default art string into canvas
		requestAnimationFrame(() => {
		  console.log("Default_ArtString length:", Default_ArtString.length);
		  if (Default_ArtString.length === 576) {
			setArtString(Default_ArtString);
			console.log("Default ArtString loaded");
		  } else {
			console.error("Default_ArtString INVALID LENGTH:", Default_ArtString.length);
		  }
		});
		
		// Render
		resizeCanvas();
		requestAnimationFrame(() => {
		  canvas.style.opacity = "1";

		  // Start color picker after first render
		  startPickerSync();
		  console.log("Picker sync started");
		});

		// Resize
		if (window.ResizeObserver) {
		  new ResizeObserver(resizeCanvas).observe(document.body);
		} else {
		  window.addEventListener("resize", resizeCanvas);
		}

        console.log("SUCCESS: Setup complete.");
        
        // Start both sync systems now that everything is ready
        startStateChecker();
        startPickerSync();

      } catch (e) {
        console.error("Rive init error:", e);
      }
    },
    onError: e => console.error("Rive load error:", e.message)
  });
});

// Cache next possible color in each pixel instance, for instant animation
function updateAllPixelPickXfer(pickerColor) {
  for (const item of pixelMap.values()) {
    const pickXfer = item.color("Color.PickXfer");
    if (pickXfer) {
      pickXfer.value = pickerColor;
    }
  }
}

// Color picker sync with virtualized cell states
function startPickerSync() {
  setInterval(() => {
    if (!MainVMi) return;
    try {
      const currentPicker = MainVMi.color("Color.Picker").value;
      if (lastPickerValue === null || currentPicker !== lastPickerValue) {
        updateAllPixelPickXfer(currentPicker);
        lastPickerValue = currentPicker;
      }
    } catch (e) {
      console.error("Picker sync error:", e);
    }
  }, 100);
}

// Send an alert message to user's UI
function sendAlert(alertMessage) {
  if (!MainVMi) return; // Silent fail early
  try {
    MainVMi.string("Alert.String").value = alertMessage;
    MainVMi.number("Alert.Interval").value = ++alertInterval; // for Rive's != self listener to respond each time, even if same message is repeated
  } catch (e) {
    console.error("Alert failed:", e);
  }
}

// Copy generated string to user's clipboard
async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
    } catch (err) {
        console.error("Failed to copy to clipboard:", err);
        throw err;
    }
}

// Store user's string from clipboard here
async function pasteToUserArtString() {
    try {
        const text = await navigator.clipboard.readText();
        const cleaned = text.trim();

        if (cleaned.length !== 576) {
			MainVMi.string("State.ImportString").value = "Invalid string length...";
            console.warn(`Invalid length: ${cleaned.length} characters (expected 576)`);
            alert(`Error: Must be exactly 576 characters (you have ${cleaned.length})`);
            return false;
        }
        if (!isValidAvatarString(cleaned)) {
            MainVMi.string("State.ImportString").value = "Invalid characters in string...";
            console.warn("Invalid characters in pasted string");
            alert("Error: String contains invalid characters");
            return false;
        }

        User_ArtStringEntry = cleaned;
		
        console.log("Valid 576-char string pasted → User_ArtStringEntry");
        console.log(User_ArtStringEntry);
		MainVMi.number("State.Paste").value = 1;
		

        return true;

    } catch (err) {
        console.error("Clipboard read failed:", err);
        alert("Failed to read clipboard. Make sure you allow clipboard access.");
        return false;
    }
}

// Color code conversion
function bgraToArgb(bgra) {
  const u = bgra >>> 0;
  const b = (u >> 0)  & 0xFF;
  const g = (u >> 8)  & 0xFF;
  const r = (u >> 16) & 0xFF;
  const a = (u >> 24) & 0xFF;
  const argb = (a << 24) | (r << 16) | (g << 8) | b;
  return argb >>> 0;  // ← CRITICAL
}

// Generate 576-Character string from current canvas
function generateArtString() {
  const result = [];

  for (let row = 0; row < 24; row++) {
    const letter = String.fromCharCode(65 + row);
    for (let col = 1; col <= 24; col++) {
      const name = `${letter}${col}`;
      const item = pixelMap.get(name);
      if (!item) {
        result.push('z');
        continue;
      }

      const cellColor = item.color("Color.Cell");
      const signed = cellColor?.value ?? 0;
      const argb = bgraToArgb(signed);

      if (name === "A1") {
        console.log(`For debug if required: ${name} color conversion checked: signed=${signed} → argb=0x${argb.toString(16).padStart(8, '0')}`);
      }

      const char = Color_To_Char[argb] || 'z';
      result.push(char);
    }
  }

  const artString = result.join('');
  console.log("ART STRING (576 chars):", artString);
  MainVMi.string("State.ArtString").value = artString;
  return artString;
}

// Import 576-Character string into canvas
function setArtString(str) {
  if (typeof str !== 'string' || str.length !== 576) {
    console.error("Invalid art string: must be 576 characters");
    return;
  }
  if (!isValidAvatarString(str)) {
    console.error("Invalid art string: contains invalid characters");
    return;
  }

  let index = 0;
  for (let row = 0; row < 24; row++) {
    const letter = String.fromCharCode(65 + row); // A to X
    for (let col = 1; col <= 24; col++) {
      const name = `${letter}${col}`;
      const char = str[index++];
      const colorValue = Char_To_Color[char] ?? 0x00000000;

      const item = pixelMap.get(name);
      if (item) {
        const cell = item.color("Color.Cell");
        if (cell) {
          cell.value = colorValue;
        }
      }
    }
  }
  console.log(`Art string applied: ${str.substring(0, 10)}... (${str.length} chars)`);
  sendAlert("Canvas updated!");
}

// Shift grid functions
function shiftUp() {
  for (let row = 0; row < 24; row++) {
    const letter = String.fromCharCode(65 + row);
    for (let col = 1; col < 24; col++) {
      const src = pixelMap.get(`${letter}${col + 1}`);
      const dst = pixelMap.get(`${letter}${col}`);
      if (src && dst) {
        dst.color("Color.Cell").value = src.color("Color.Cell").value;
      }
    }
    const last = pixelMap.get(`${letter}24`);
    if (last) last.color("Color.Cell").value = 0x00000000;
  }
  console.log("Canvas shifted UP");
}

function shiftDown() {
  for (let row = 0; row < 24; row++) {
    const letter = String.fromCharCode(65 + row);
    for (let col = 23; col >= 1; col--) {
      const src = pixelMap.get(`${letter}${col}`);
      const dst = pixelMap.get(`${letter}${col + 1}`);
      if (src && dst) {
        dst.color("Color.Cell").value = src.color("Color.Cell").value;
      }
    }
    const first = pixelMap.get(`${letter}1`);
    if (first) first.color("Color.Cell").value = 0x00000000;
  }
  console.log("Canvas shifted DOWN");
}

function shiftLeft() {
  for (let col = 1; col <= 24; col++) {
    for (let row = 0; row < 23; row++) {
      const srcLetter = String.fromCharCode(66 + row);
      const dstLetter = String.fromCharCode(65 + row);
      const src = pixelMap.get(`${srcLetter}${col}`);
      const dst = pixelMap.get(`${dstLetter}${col}`);
      if (src && dst) {
        dst.color("Color.Cell").value = src.color("Color.Cell").value;
      }
    }
    const bottom = pixelMap.get(`X${col}`);
    if (bottom) bottom.color("Color.Cell").value = 0x00000000;
  }
  console.log("Canvas shifted LEFT");
}

function shiftRight() {
  for (let col = 1; col <= 24; col++) {
    for (let row = 22; row >= 0; row--) {
      const srcLetter = String.fromCharCode(65 + row);
      const dstLetter = String.fromCharCode(66 + row);
      const src = pixelMap.get(`${srcLetter}${col}`);
      const dst = pixelMap.get(`${dstLetter}${col}`);
      if (src && dst) {
        dst.color("Color.Cell").value = src.color("Color.Cell").value;
      }
    }
    const top = pixelMap.get(`A${col}`);
    if (top) top.color("Color.Cell").value = 0x00000000;
  }
  console.log("Canvas shifted RIGHT");
}

// Dispatch functions for UI states
const stateActions = {
  "601": shiftLeft,
  "602": shiftRight,
  "603": shiftUp,
  "604": shiftDown,
  "201": closeSocket,
  "202": connectWebSocket,
  "300": registerAccount,
  "301": unregisterAccount,
  "550": generateArtString,
  "551": async () => {
    const str = MainVMi.string("State.ArtString").value?.trim();
    if (str) {
      await copyToClipboard(str);
      sendAlert("Art string copied to clipboard!");
      MainVMi.string("State.ArtString").value = "Copied!";
    }
  },
  "562": importFromImage,
  "563": exportAsFramedPNG,
  "564": exportAs24PNG,
  "565": storeAvatarOnChain,
  "566": loadAvatarFromChain,
  "700": () => {
    if (typeof openGallery === "function") {
        openGallery();
    } else {
        console.error("Gallery not loaded yet!");
        sendAlert("Gallery not available.");
    }
  },
  "900": () => setArtString(Blank_ArtString),
  "560": async () => {
    const success = await pasteToUserArtString();
    if (success && User_ArtStringEntry?.length === 576) {
      MainVMi.string("State.ImportString").value = User_ArtStringEntry;
    }
  },
  "561": () => {
    const str = User_ArtStringEntry;
    setArtString(str && str.length === 576 ? str : Blank_ArtString);
    User_ArtStringEntry = "";
    MainVMi.string("State.ImportString").value = "Waiting...";
  }
};

// UI state check interval
function startStateChecker() {
  if (checkCallStates) return; // already running

  checkCallStates = setInterval(() => {
    if (!MainVMi) return; // extra safety

    const value = MainVMi.string("FunctionCall.Case")?.value?.trim();

    if (value && value !== "100" && stateActions[value]) {
      try {
        stateActions[value]();
      } catch (err) {
        console.error(`State action "${value}" failed:`, err);
        sendAlert("Action failed!");
      } finally {
        MainVMi.string("FunctionCall.Case").value = "100";
      }
    }
  }, 200);

  console.log("State dispatcher started");
}

// Import 24x24 image to canvas
async function importFromImage() {
  // Create hidden file input
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg';
  input.style.display = 'none';
  document.body.appendChild(input);

  const file = await new Promise((resolve) => {
    input.onchange = (e) => {
      document.body.removeChild(input);
      resolve(e.target.files[0] || null);
    };
    input.click();
  });

  if (!file) {
    sendAlert("No file selected!");
    return;
  }

  // Validate MIME type
  if (!['image/png', 'image/jpeg'].includes(file.type)) {
    sendAlert("Only PNG or JPG files are allowed!");
    return;
  }

  // Load image
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = URL.createObjectURL(file);
  });

  // Validate exact size
  if (img.naturalWidth !== 24 || img.naturalHeight !== 24) {
    URL.revokeObjectURL(img.src);
    sendAlert("Image must be exactly 24×24 pixels!");
    return;
  }

  // Draw to off-screen canvas
  const canvas = document.createElement('canvas');
  canvas.width = 24;
  canvas.height = 24;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  URL.revokeObjectURL(img.src);

  const imageData = ctx.getImageData(0, 0, 24, 24).data;

  // Find closest allowed color
  function nearestColor(r, g, b, a) {
    if (a === 0) return 0x00000000;

    let bestKey = 0x00000000;
    let bestDist = Infinity;

    for (const [keyHex, _char] of Object.entries(Color_To_Char)) {
      const key = parseInt(keyHex);
      const cr = (key >> 16) & 0xFF;
      const cg = (key >> 8)  & 0xFF;
      const cb = key & 0xFF;
      const ca = (key >> 24) & 0xFF;

      // Prefer alpha match, but allow opaque fallback
      if (ca !== 255 && ca !== a) continue;

      const dr = r - cr;
      const dg = g - cg;
      const db = b - cb;
      const dist = dr*dr + dg*dg + db*db;

      if (dist < bestDist) {
        bestDist = dist;
        bestKey = key;
      }
    }
    return bestKey;
  }

  // Build string 
  const result = [];
  for (let col = 0; col < 24; col++) {
    for (let row = 0; row < 24; row++) {
      const pixelIndex = (row * 24 + col) * 4;

      const r = imageData[pixelIndex];
      const g = imageData[pixelIndex + 1];
      const b = imageData[pixelIndex + 2];
      const a = imageData[pixelIndex + 3];

      const nearestArgb = nearestColor(r, g, b, a);
      const char = Color_To_Char[nearestArgb] || 'z';
      result.push(char);
    }
  }

  const artString = result.join('');

  // Apply to canvas
  User_ArtStringEntry = artString;
  setArtString(artString);

  sendAlert("Image interpreted and imported successfully!");
  console.log("24×24 image imported, column-major 576-char string applied");
}


// Export current canvas as a clean PNG with deterministic frame
function exportAsFramedPNG() {
    const artString = generateArtString();
    if (artString.length !== 576) {
        sendAlert("Error generating avatar data!");
        return;
    }

    const currentAddress = myAddress;
    if (!currentAddress) {
        sendAlert("Connect wallet for export!");
        console.warn("Export failed: no address available!");
        return;
    }

    sendAlert("Generating your Villager...");

    generateAvatarWithFrame(currentAddress, artString, 800)
        .then(url => {
            const a = document.createElement('a');
            a.href = url;
            a.download = `villager-${currentAddress.slice(-12)}-${Date.now()}.png`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);

            URL.revokeObjectURL(url);

            sendAlert("Canvas PNG downloaded!");
            console.log("Exported full-res framed Villager for", currentAddress);
        })
        .catch(err => {
            console.error("Export failed:", err);
            sendAlert("Export failed, please try again");
        });
}

// Export current canvas as a 24×24 PNG backup file
function exportAs24PNG() {
  // Get fresh art string from canvas
  const artString = generateArtString();
  if (artString.length !== 576) {
    sendAlert("Error generating artString data!");
    return;
  }

  // Create 24×24 canvas
  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = 24;
  exportCanvas.height = 24;
  const ctx = exportCanvas.getContext('2d');

  let charIndex = 0;

  // Fill in canvas
  for (let gridX = 0; gridX < 24; gridX++) {
    for (let gridY = 0; gridY < 24; gridY++) {
      const char = artString[charIndex++];
      const argb = Char_To_Color[char] || 0x00000000;

      const a = (argb >> 24) & 0xFF;
      const r = (argb >> 16) & 0xFF;
      const g = (argb >> 8)  & 0xFF;
      const b =  argb        & 0xFF;

      ctx.fillStyle = `rgba(${r},${g},${b},${a / 255})`;
      ctx.fillRect(gridX, gridY, 1, 1);
    }
  }

  // Trigger download
  exportCanvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `villager-backup-24x24-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    sendAlert("24×24 PNG downloaded!");
    console.log("Exported 24×24 PNG");
  }, 'image/png');
}