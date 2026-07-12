// CUSTOM 32-BIT HASH FUNCTION
function simpleHash(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
        h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
        h = h << 13 | h >>> 19;
    }
    return h >>> 0;
}

// FRAME AND BACKGROUND TYPE NAMES
const FRAME_NAMES = ['Polygon Shards', 'Crystal Shards', 'Glitch Rings', 'Crystal Grid', 'Nebula Rings'];
const BG_NAMES = ['Radial Gradient', 'Linear Gradient', 'Inverted Radial', 'Conic Gradient'];

// CACHE FULL SIZE AVATARS SO WE NEVER REGENERATE THEM TWICE
window.avatarCache = new Map();

function updateProgress(percent, text) {
    return new Promise(resolve => {
        setTimeout(() => {
            const fill = document.getElementById("progressFill");
            const textEl = document.getElementById("loadingText");
            if (fill) {
                fill.style.width = percent + "%";
                let color;
                if (percent < 33) color = 'hsl(30, 100%, 75%)'; // Bright pastel orange
                else if (percent < 66) color = 'hsl(60, 100%, 75%)'; // Bright pastel yellow
                else color = 'hsl(120, 100%, 75%)'; // Bright pastel green
                fill.style.backgroundColor = color;
                // Update spinner color
                const spinner = document.querySelector('.loading-spinner');
                if (spinner) spinner.style.setProperty('--spinner-color', color);
            }
            if (textEl) textEl.textContent = text;
            resolve();
        }, 100);
    });
}
async function getAvatarUrl(address, avatarStr, requestedSize = 180) {
    const cacheKey = address;

    // If we already have the full-size version, reuse it
    if (!avatarCache.has(cacheKey)) {
        console.log(`Generating avatar image for ${address}`);
        const fullBlobUrl = await generateAvatarWithFrame(address, avatarStr, 800);
        avatarCache.set(cacheKey, fullBlobUrl);
    }

    const fullUrl = avatarCache.get(cacheKey);

    // If they want full size, return it directly
    if (requestedSize >= 800) {
        return fullUrl;
    }

    // Otherwise: create a scaled-down version using canvas
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

            // Compute average color for glow
            const imageData = ctx.getImageData(0, 0, requestedSize, requestedSize);
            let r = 0, g = 0, b = 0, count = 0;
            for (let i = 0; i < imageData.data.length; i += 4) {
                if (imageData.data[i + 3] > 0) {
                    r += imageData.data[i];
                    g += imageData.data[i + 1];
                    b += imageData.data[i + 2];
                    count++;
                }
            }
            if (count > 0) {
                r = Math.floor(r / count);
                g = Math.floor(g / count);
                b = Math.floor(b / count);
            } else {
                // Default to white glow if no opaque pixels
                r = 255; g = 255; b = 255;
            }
            const glowColor = `rgba(${r}, ${g}, ${b}, 0.8)`;

            resolve({ element: canvas, glowColor });
        };
        img.src = fullUrl;
    });
}

// GENERATE UNIQUE FRAME + AVATAR
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
        grad.addColorStop(1, `hsl(${(bgSeed + 150) % 360}, 90%, 15%)`);
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
        grad.addColorStop(0.33, `hsl(${(bgSeed + 30) % 360}, 85%, 42%)`);
        grad.addColorStop(0.5, `hsl(${(bgSeed + 45) % 360}, 75%, 35%)`);
        grad.addColorStop(0.66, `hsl(${(bgSeed + 60) % 360}, 65%, 30%)`);
        grad.addColorStop(0.83, `hsl(${((bgSeed + 75) % 360)}, 60%, 28%)`);
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

    // FRAME STYLES (5 unique looks)
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
            ctx.shadowColor = 'transparent';
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

// GALLERY CONFIGURATION
const AVATARS_PER_PAGE = 36;
let currentPage = 1;
let avatarEntries = [];
let currentUrls = [];

// SORTING SYSTEM
let sortOrderNewest = true;

function applySorting() {
    return new Promise(resolve => {
        if (sortOrderNewest) {
            avatarEntries.sort((a, b) => b[2] - a[2]);
        } else {
            avatarEntries.sort((a, b) => a[2] - b[2]);
        }
        const elements = document.querySelectorAll('.thumbnail-container img, .thumbnail-container canvas');
        elements.forEach((element, index) => {
            const container = element.parentElement;
            const spinner = document.createElement('div');
            spinner.className = 'thumbnail-spinner';
            container.appendChild(spinner);
            element.style.transitionDelay = `${index * 50}ms`;
            element.style.opacity = '0';
            element.style.transform = 'translateY(-20px)';
        });
        const totalDelay = 300 + (elements.length - 1) * 50;
        setTimeout(() => {
            renderPage(currentPage, true);
            resolve();
        }, totalDelay);
    });
}

function openSearchModal() {
    const modal = document.getElementById("searchModal");
    if (modal) modal.classList.add("show");
    document.getElementById("searchInput").focus();
}

function closeSearchModal() {
    const modal = document.getElementById("searchModal");
    if (modal) modal.classList.remove("show");
    document.getElementById("searchInput").value = "";
}

function performSearch() {
    const query = document.getElementById("searchInput").value.trim();
    if (!query) return;
    const lowerQuery = query.toLowerCase();
    const match = avatarEntries.find(([address]) => address.toLowerCase().includes(lowerQuery));
    closeSearchModal();
    if (match) {
        const [address, avatarStr] = match;
        showFullView(address, avatarStr);
    }
}

document.addEventListener("keydown", e => {
    if (e.key === "Enter" && document.getElementById("searchModal")?.classList.contains("show")) performSearch();
    if (e.key === "Escape") closeSearchModal();
});

async function openGallery() {
    const modal = document.getElementById("galleryModal");
    const loading = document.getElementById("galleryLoading");
    const content = document.getElementById("galleryContent");
    if (modal) {
        modal.classList.add("show");
        loading.style.display = 'flex';
        content.style.display = 'none';
        await updateProgress(0, "Fetching data...");
    }
    await window.refreshAvatars();
    if (!window.storedAvatars || Object.keys(window.storedAvatars).length === 0) {
        console.error("No avatars available for gallery!");
        return;
    }
    avatarEntries = Object.keys(window.storedAvatars).map(addr => [addr, window.storedAvatars[addr], window.avatarTimestamps[addr] || 0]);
    await updateProgress(25, `Fetched ${avatarEntries.length} avatars...`);
    await updateProgress(50, `Processing ${avatarEntries.length} avatars...`);
    await applySorting();
    await updateProgress(75, `Sorted ${avatarEntries.length} avatars...`);
    await updateProgress(100, `Rendering ${avatarEntries.length} villagers...`);
    console.log(`Gallery loaded ${avatarEntries.length} Villagers`);
    if (loading) loading.style.display = 'none';
    if (content) content.style.display = 'block';
}

function closeGallery() {
    const modal = document.getElementById("galleryModal");
    if (modal) modal.classList.remove("show");
    revokeCurrentUrls();
    avatarCache.forEach(url => URL.revokeObjectURL(url));
    avatarCache.clear();
    // Reset loading and content for next open
    const loading = document.getElementById("galleryLoading");
    const content = document.getElementById("galleryContent");
    if (loading) loading.style.display = 'flex';
    if (content) content.style.display = 'none';
}

function revokeCurrentUrls() {
    currentUrls.forEach(url => URL.revokeObjectURL(url));
    currentUrls = [];
}

function renderPage(page, animate = false) {
    revokeCurrentUrls();
    // Clear avatar cache to only keep current page's renders
    avatarCache.forEach(url => URL.revokeObjectURL(url));
    avatarCache.clear();
    currentPage = page;
    const grid = document.getElementById("thumbnailGrid");
    grid.innerHTML = '';

    const start = (page - 1) * AVATARS_PER_PAGE;
    const end = Math.min(start + AVATARS_PER_PAGE, avatarEntries.length);

    for (let i = start; i < end; i++) {
        const [address, avatarStr] = avatarEntries[i];
        const container = document.createElement('div');
        container.className = 'thumbnail-container';

        const spinner = document.createElement('div');
        spinner.className = 'thumbnail-spinner';
        container.appendChild(spinner);

        getAvatarUrl(address, avatarStr, 180).then(thumb => {
            // thumb is {element: canvas, glowColor: string} for thumbnails, or string URL for full size
            const element = thumb.element || thumb;
            const glowColor = thumb.glowColor || 'rgba(255, 255, 255, 0.8)';
            container.style.setProperty('--glow-color', glowColor);
            if (element.tagName === 'CANVAS') {
                container.appendChild(element);
                const label = document.createElement('div');
                label.className = 'thumbnail-label';
                label.textContent = `Block: ${avatarEntries[i][2]}`;
                container.appendChild(label);
                const addrLabel = document.createElement('div');
                addrLabel.className = 'thumbnail-address';
                addrLabel.textContent = `...${address.slice(-6)}`;
                container.appendChild(addrLabel);
                const orderLabel = document.createElement('div');
                orderLabel.className = 'thumbnail-order';
                const globalIndex = start + i;
                const order = sortOrderNewest ? (avatarEntries.length - globalIndex) : (globalIndex + 1);
                orderLabel.textContent = `#${order}`;
                container.appendChild(orderLabel);
                element.style.display = 'block';
                if (animate) {
                    element.style.opacity = '0';
                    element.style.transform = 'translateY(-20px)';
                    setTimeout(() => {
                        element.style.opacity = '1';
                        element.style.transform = 'translateY(0)';
                        spinner.classList.add('fade-out');
                    }, 10);
                    setTimeout(() => container.removeChild(spinner), 300);
                } else {
                    element.style.opacity = '1';
                    element.style.transform = 'translateY(0)';
                    container.removeChild(spinner);
                }
            } else {
                // Fallback for full size img
                const img = document.createElement('img');
                img.src = element;
                container.appendChild(img);
                const label = document.createElement('div');
                label.className = 'thumbnail-label';
                label.textContent = `Block: ${avatarEntries[i][2]}`;
                container.appendChild(label);
                const addrLabel = document.createElement('div');
                addrLabel.className = 'thumbnail-address';
                addrLabel.textContent = `...${address.slice(-6)}`;
                container.appendChild(addrLabel);
                const orderLabel = document.createElement('div');
                orderLabel.className = 'thumbnail-order';
                const globalIndex = start + i;
                const order = sortOrderNewest ? (avatarEntries.length - globalIndex) : (globalIndex + 1);
                orderLabel.textContent = `#${order}`;
                container.appendChild(orderLabel);
                img.style.display = 'block';
                if (animate) {
                    img.style.opacity = '0';
                    img.style.transform = 'translateY(-20px)';
                    setTimeout(() => {
                        img.style.opacity = '1';
                        img.style.transform = 'translateY(0)';
                        spinner.style.opacity = '0';
                    }, 10);
                    setTimeout(() => container.removeChild(spinner), 300);
                } else {
                    img.style.opacity = '1';
                    img.style.transform = 'translateY(0)';
                    container.removeChild(spinner);
                }
                currentUrls.push(element);
            }
        }).catch(err => {
            console.error(err);
            container.removeChild(spinner);
            container.innerHTML = '<p>Error</p>';
        });

        container.addEventListener('click', () => showFullView(address, avatarStr));
        grid.appendChild(container);
    }

    const totalPages = Math.ceil(avatarEntries.length / AVATARS_PER_PAGE);
    document.getElementById("pagination").innerHTML = `
        <button ${page === 1 ? 'disabled' : ''} onclick="renderPage(${page - 1})">PREV</button>
        <span>${page} / ${totalPages}</span>
        <button ${page === totalPages ? 'disabled' : ''} onclick="renderPage(${page + 1})">NEXT</button>
    `;
}

let currentFront = null;

async function showFullView(address, avatarStr) {
    console.log(`Displaying full view for avatar: ${address}`);
    const fullModal = document.getElementById("fullViewModal");
    const fullImg   = document.getElementById("fullImage");
    const addressOverlay = document.querySelector('.full-image-container .address-overlay');
    const blockOverlay = document.querySelector('.full-image-container .block-overlay');

    // Remove existing order label if any
    const existingOrder = document.querySelector('.order-label');
    if (existingOrder) existingOrder.remove();

    fullImg.classList.remove("loaded", "flipped");
    fullImg.src = "";
    fullImg.style.backgroundImage = "";
    const timestamp = window.avatarTimestamps[address] || 'Unknown';
    const uniquePart = address.startsWith('dero1') ? address.slice(5) : address;
    const frameSeed = simpleHash(uniquePart + "FRAME");
    const bgSeed = simpleHash(uniquePart + "BACKGROUND");
    const frameType = frameSeed % 5;
    const bgType = bgSeed % 4;
    const frameHue = frameSeed % 360;
    const frameRotation = (frameSeed % 91) - 45;
    const frameGlowCount = 1 + (frameSeed % 3);
    const bgHue = bgSeed % 360;
    const cxOffset = (simpleHash(uniquePart + "CX") % 50) - 25;
    const cyOffset = (simpleHash(uniquePart + "CY") % 50) - 25;
    const globalIndex = avatarEntries.findIndex(([addr]) => addr === address);
    const order = globalIndex !== -1 ? (sortOrderNewest ? (avatarEntries.length - globalIndex) : (globalIndex + 1)) : 'Unknown';
    addressOverlay.innerHTML = `
        <div class="overlay-header">Villager Data</div>
        <div class="table-container">
            <table class="info-table">
            <colgroup><col style="width: 160px;"><col></colgroup>
                <tr><td>Age Rank:</td><td>#${order}</td></tr>
                <tr><td>Stored at Block:</td><td>${timestamp}</td></tr>
                <tr><td>Input Address:</td><td>${address}</td></tr>
                <tr class="frame-seed"><td>Frame Seed:</td><td>${frameSeed}</td></tr>
                <tr class="frame-style"><td>Frame Style:</td><td>${FRAME_NAMES[frameType]}</td></tr>
                <tr class="frame-values"><td>Frame Values:</td><td>Hue: ${frameHue}° Rot: ${frameRotation}° Glow: ${frameGlowCount}</td></tr>
                <tr class="background-seed"><td>Background Seed:</td><td>${bgSeed}</td></tr>
                <tr class="background-style"><td>Background Style:</td><td>${BG_NAMES[bgType]}</td></tr>
                <tr class="background-values"><td>Background Values:</td><td>Hue: ${bgHue}° Offset: ${cxOffset}, ${cyOffset}</td></tr>
            </table>
        </div>
    `;

    // Start collapsed
    addressOverlay.classList.add('collapsed');

    // Get glow color for modal background
    const thumb = await getAvatarUrl(address, avatarStr, 180);
    const glowColor = thumb.glowColor || 'rgba(0, 0, 0, 0.6)';
    const rgbaMatch = glowColor.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*[\d.]+\)/);
    if (rgbaMatch) {
        const r = rgbaMatch[1], g = rgbaMatch[2], b = rgbaMatch[3];
        fullModal.style.background = `rgba(${r}, ${g}, ${b}, 0.6)`;
    } else {
        fullModal.style.background = 'rgba(0, 0, 0, 0.6)';
    }

    fullModal.classList.add("show");

    const url = await getAvatarUrl(address, avatarStr, 800);
    currentFront = url;
    fullImg.src = url;
    fullImg.style.backgroundImage = `url(${url})`;
    fullImg.classList.add("loaded");

    // Reset flip state
    const fullContainer = document.querySelector('.full-image-container');
    if (fullContainer) {
        fullContainer.classList.remove("flipped");
    }

    console.log(`Avatar image loaded and displayed for ${address}`);
}

function closeFullView() {
    const fullModal = document.getElementById("fullViewModal");
    if (fullModal) {
        fullModal.classList.remove("show");
    }
    window.getSelection().removeAllRanges();
}

// DOM READY SETUP UI
document.addEventListener("DOMContentLoaded", () => {
    const galleryHTML = `
        <div id="galleryModal" class="gallery-modal">
            <div id="galleryLoading" class="loading-overlay" style="display: flex; align-items: center; justify-content: center; position: absolute; top: 0; left: 0; width: 100%; height: 100dvh; background: rgba(0,0,0,0.8); z-index: 10;">
                <div class="loading-spinner">
                    <div class="loading-content">
                        <p id="loadingText" style="width: 100%; margin: 0; text-align: center; color: white; font-size: 11px; line-height: 1.1;">Loading Villagers...</p>
                        <div class="progress-bar" style="margin-top: 10px;"><div class="progress-fill" id="progressFill"></div></div>
                    </div>
                </div>
            </div>
            <div id="galleryContent" style="display: none;">
                <div class="gallery-header">
                    <div style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap;">
                        <button class="search-btn" onclick="openSearchModal()" title="Search by Address">SEARCH</button>
                        <button id="myVillagerBtn" class="search-btn" title="Jump to your own Villager">ME</button>
                        <button id="sortOldestBtn" class="search-btn" title="Show oldest first">OLDEST</button>
                        <button id="sortNewestBtn" class="search-btn active-sort" title="Show newest first">NEWEST</button>
                    </div>
                    <span class="close" onclick="closeGallery()">×</span>
                </div>
                <div class="gallery-content">
                    <div id="thumbnailGrid" class="thumbnail-grid"></div>
                </div>
                <div id="pagination" class="pagination"></div>
            </div>
        </div>

        <div id="searchModal" class="gallery-modal search-modal">
            <div class="search-modal-content">
                <span class="close" onclick="closeSearchModal()">×</span>
                <h3>Search For A Villager</h3>
                <div class="search-input-wrapper">
                    <input type="text" id="searchInput" placeholder="dero1..." autocomplete="off">
                    <button class="clear-input" onclick="document.getElementById('searchInput').value='';document.getElementById('searchInput').focus();this.style.opacity='0'" title="Clear">×</button>
                </div>
                <button class="search-action-btn" onclick="performSearch()">Search</button>
            </div>
        </div>

        <div id="fullViewModal" class="full-view-modal">
            <span class="full-close" onclick="closeFullView()">×</span>
            <div class="full-image-container">
                <img id="fullImage" src="" alt="Full Villager View">
                <div class="address-overlay"></div>
            </div>
        </div>
    `;

    document.body.insertAdjacentHTML('beforeend', galleryHTML);

    // Address overlay toggle listener
    const addressOverlay = document.querySelector('.full-image-container .address-overlay');
    addressOverlay.addEventListener('click', (e) => {
        e.stopPropagation();
        if (addressOverlay.classList.contains('collapsed')) {
            addressOverlay.classList.add('expanding');
            addressOverlay.classList.add('clicked');
            setTimeout(() => {
                addressOverlay.classList.remove('expanding');
                addressOverlay.classList.remove('clicked');
            }, 600);
            addressOverlay.classList.remove('collapsed');
        } else {
            if (window.getSelection().toString().length > 0) return;
            addressOverlay.classList.add('collapsing');
            addressOverlay.classList.add('clicked');
            setTimeout(() => {
                addressOverlay.classList.remove('collapsing');
                addressOverlay.classList.remove('clicked');
            }, 600);
            addressOverlay.classList.add('collapsed');
            window.getSelection().removeAllRanges();
        }
    });

    // Search input clear button
    const input = document.getElementById("searchInput");
    const clearBtn = document.querySelector(".clear-input");
    input.addEventListener("input", () => {
        clearBtn.style.opacity = input.value ? "1" : "0";
        clearBtn.style.pointerEvents = input.value ? "all" : "none";
    });
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            performSearch();
        }
    });

    // Full view flip animation
    const fullImg = document.getElementById("fullImage");
    if (fullImg) {
        fullImg.addEventListener("click", function () {
            this.classList.toggle("flipped");
        });
    }

    // My Villager button
    document.getElementById("myVillagerBtn")?.addEventListener("click", () => {
        const userAddr = window.myAddress || "";
        if (!userAddr) {
            sendAlert("Wallet not connected yet!");
            return;
        }
        const lowerUserAddr = userAddr.toLowerCase();
        const match = avatarEntries.find(([addr]) => addr.toLowerCase() === lowerUserAddr);
        if (match) {
            const [address, avatarStr] = match;
            showFullView(address, avatarStr);
        } else {
            sendAlert("You haven't saved a Villager yet!");
        }
    });

    // SORTING SYSTEM
    document.getElementById("sortOldestBtn")?.addEventListener("click", () => {
        if (sortOrderNewest) {
            sortOrderNewest = false;
            document.getElementById("sortOldestBtn").classList.add("active-sort");
            document.getElementById("sortNewestBtn").classList.remove("active-sort");
            applySorting();
        }
    });

    document.getElementById("sortNewestBtn")?.addEventListener("click", () => {
        if (!sortOrderNewest) {
            sortOrderNewest = true;
            document.getElementById("sortNewestBtn").classList.add("active-sort");
            document.getElementById("sortOldestBtn").classList.remove("active-sort");
            applySorting();
        }
    });
});

window.addEventListener('beforeunload', () => {
    avatarCache.forEach(url => URL.revokeObjectURL(url));
    avatarCache.clear();
});

// SEARCH MODAL FUNCTIONS
function openSearchModal() {
    const modal = document.getElementById("searchModal");
    if (modal) {
        modal.classList.add("show");
        document.getElementById("searchInput").focus();
    }
}

function closeSearchModal() {
    const modal = document.getElementById("searchModal");
    if (modal) {
        modal.classList.remove("show");
        const input = document.getElementById("searchInput");
        if (input) input.value = "";
        const clearBtn = document.querySelector(".clear-input");
        if (clearBtn) {
            clearBtn.style.opacity = "0";
            clearBtn.style.pointerEvents = "none";
        }
    }
}

function performSearch() {
    const input = document.getElementById("searchInput");
    if (!input) return;
    const query = input.value.trim().toLowerCase();
    if (!query) return;

    console.log(`Searching for avatar with query: "${query}"`);
    const match = avatarEntries.find(([addr]) => addr.toLowerCase().includes(query));
    if (match) {
        const [address, avatarStr] = match;
        console.log(`Avatar found for address: ${address}`);
        closeSearchModal();
        showFullView(address, avatarStr);
    } else {
        console.log(`No avatar found for query: "${query}"`);
        // Show "no result" message and revert after 2 seconds
        const modalContent = document.querySelector(".search-modal-content");
        const originalHTML = modalContent.innerHTML;
        modalContent.innerHTML = `
            <span class="close" onclick="closeSearchModal()">×</span>
            <h3>No Villager Found</h3>
            <p style="color: #ccc; margin: 20px 0;">No avatar found for that address.</p>
            <button class="search-action-btn" onclick="closeSearchModal()">Close</button>
        `;
        setTimeout(() => {
            modalContent.innerHTML = originalHTML;
            // Re-attach event listeners
            const input = document.getElementById("searchInput");
            const clearBtn = document.querySelector(".clear-input");
            input.addEventListener("input", () => {
                clearBtn.style.opacity = input.value ? "1" : "0";
                clearBtn.style.pointerEvents = input.value ? "all" : "none";
            });
            input.addEventListener("keydown", (e) => {
                if (e.key === "Enter") {
                    performSearch();
                }
            });
        }, 2000);
    }
}

// EXPORT FUNCTIONS TO GLOBAL SCOPE
window.openGallery = openGallery;
window.closeGallery = closeGallery;
window.renderPage = renderPage;
window.openSearchModal = openSearchModal;
window.generateAvatarWithFrame = generateAvatarWithFrame;
