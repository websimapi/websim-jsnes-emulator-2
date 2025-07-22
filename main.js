// Wait for jsnes to be loaded from the script tag
if (typeof jsnes === 'undefined') {
    throw new Error('jsnes not loaded!');
}
const NES = jsnes.NES;

const SCREEN_WIDTH = 256;
const SCREEN_HEIGHT = 240;
const FRAMEBUFFER_SIZE = SCREEN_WIDTH * SCREEN_HEIGHT;

const canvas = document.getElementById('screen');
const canvasContext = canvas.getContext('2d', { willReadFrequently: true });
const romFile = document.getElementById('rom-file');
const romLoader = document.getElementById('rom-loader');
const statusDiv = document.getElementById('status');

let imageData = canvasContext.getImageData(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
let framebuffer_u8 = new Uint8ClampedArray(imageData.data.buffer);
let framebuffer_u32 = new Uint32Array(imageData.data.buffer);

let nes = null;
let animationFrameId = null;

// --- Timing ---
const NTSC_FRAMERATE = 60.0988;
const FRAME_TIME = 1000 / NTSC_FRAMERATE;
let lastFrameTime = 0;
let accumulator = 0;

// --- Audio ---
const AUDIO_BUFFERING = 512;
const SAMPLE_COUNT = 4 * 1024;
const SAMPLE_MASK = SAMPLE_COUNT - 1;
const audio_samples_L = new Float32Array(SAMPLE_COUNT);
const audio_samples_R = new Float32Array(SAMPLE_COUNT);
let audio_write_cursor = 0;
let audio_read_cursor = 0;
let audioContext = null;

function audio_remain() {
    return (audio_write_cursor - audio_read_cursor) & SAMPLE_MASK;
}

function audio_callback(event) {
    if (!nes) return;

    const dst_l = event.outputBuffer.getChannelData(0);
    const dst_r = event.outputBuffer.getChannelData(1);
    const len = dst_l.length;

    const remain = audio_remain();
    const samples_to_process = Math.min(len, remain);

    for (let i = 0; i < samples_to_process; i++) {
        dst_l[i] = audio_samples_L[audio_read_cursor];
        dst_r[i] = audio_samples_R[audio_read_cursor];
        audio_read_cursor = (audio_read_cursor + 1) & SAMPLE_MASK;
    }
     for (let i = samples_to_process; i < len; i++) {
        dst_l[i] = 0;
        dst_r[i] = 0;
    }
}

function onAudioSample(l, r) {
    audio_samples_L[audio_write_cursor] = l;
    audio_samples_R[audio_write_cursor] = r;
    audio_write_cursor = (audio_write_cursor + 1) & SAMPLE_MASK;
}

// --- Main Loop ---

function onFrame(frameBuffer) {
    for (let i = 0; i < FRAMEBUFFER_SIZE; i++) {
        framebuffer_u32[i] = 0xFF000000 | frameBuffer[i];
    }
    canvasContext.putImageData(imageData, 0, 0);
}

function main_loop(timestamp) {
    if (!nes) {
        return;
    }

    if (lastFrameTime === 0) {
        lastFrameTime = timestamp;
    }

    accumulator += timestamp - lastFrameTime;
    lastFrameTime = timestamp;

    while (accumulator >= FRAME_TIME) {
        nes.frame();
        accumulator -= FRAME_TIME;
    }

    animationFrameId = requestAnimationFrame(main_loop);
}

function startEmulator(romData) {
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
    }
    if (audioContext) {
        audioContext.close();
    }

    statusDiv.textContent = 'Emulator running.';
    romLoader.classList.add('hidden');

    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const scriptNode = audioContext.createScriptProcessor(AUDIO_BUFFERING, 0, 2);
    scriptNode.onaudioprocess = audio_callback;
    scriptNode.connect(audioContext.destination);

    nes = new NES({
        onFrame: onFrame,
        onAudioSample: onAudioSample,
        sampleRate: audioContext.sampleRate,
    });

    nes.loadROM(romData);
    
    lastFrameTime = 0;
    accumulator = 0;
    animationFrameId = requestAnimationFrame(main_loop);
}


// --- Controls ---
const KEYMAP = {
    87: {p: 1, b: jsnes.Controller.BUTTON_UP},     // W
    83: {p: 1, b: jsnes.Controller.BUTTON_DOWN},   // S
    65: {p: 1, b: jsnes.Controller.BUTTON_LEFT},   // A
    68: {p: 1, b: jsnes.Controller.BUTTON_RIGHT},  // D
    38: {p: 1, b: jsnes.Controller.BUTTON_UP},     // Up
    40: {p: 1, b: jsnes.Controller.BUTTON_DOWN},   // Down
    37: {p: 1, b: jsnes.Controller.BUTTON_LEFT},   // Left
    39: {p: 1, b: jsnes.Controller.BUTTON_RIGHT},  // Right
    75: {p: 1, b: jsnes.Controller.BUTTON_A},      // K
    74: {p: 1, b: jsnes.Controller.BUTTON_B},      // J
    13: {p: 1, b: jsnes.Controller.BUTTON_START},  // Enter
    16: {p: 1, b: jsnes.Controller.BUTTON_SELECT}, // Shift
};

function handleKey(e, isDown) {
    if (KEYMAP.hasOwnProperty(e.keyCode)) {
        const {p, b} = KEYMAP[e.keyCode];
        if (nes) {
            if (isDown) {
                nes.buttonDown(p, b);
            } else {
                nes.buttonUp(p, b);
            }
        }
        e.preventDefault();
    }
}

document.addEventListener('keydown', (e) => handleKey(e, true));
document.addEventListener('keyup', (e) => handleKey(e, false));


// --- Mobile Controls ---
const dPad = document.getElementById('d-pad');
const dPadUp = dPad.querySelector('.d-pad-up');
const dPadDown = dPad.querySelector('.d-pad-down');
const dPadLeft = dPad.querySelector('.d-pad-left');
const dPadRight = dPad.querySelector('.d-pad-right');

const buttonMap = {
    'a-button': { p: 1, b: jsnes.Controller.BUTTON_A },
    'b-button': { p: 1, b: jsnes.Controller.BUTTON_B },
    'start-button': { p: 1, b: jsnes.Controller.BUTTON_START },
    'select-button': { p: 1, b: jsnes.Controller.BUTTON_SELECT },
};

const dPadState = {
    up: false,
    down: false,
    left: false,
    right: false,
};

function updateDPadVisuals() {
    dPadUp.classList.toggle('active', dPadState.up);
    dPadDown.classList.toggle('active', dPadState.down);
    dPadLeft.classList.toggle('active', dPadState.left);
    dPadRight.classList.toggle('active', dPadState.right);
}

function setDPadState(up, down, left, right) {
    if (!nes) return;

    if (dPadState.up !== up) {
        dPadState.up = up;
        if (up) nes.buttonDown(1, jsnes.Controller.BUTTON_UP);
        else nes.buttonUp(1, jsnes.Controller.BUTTON_UP);
    }
    if (dPadState.down !== down) {
        dPadState.down = down;
        if (down) nes.buttonDown(1, jsnes.Controller.BUTTON_DOWN);
        else nes.buttonUp(1, jsnes.Controller.BUTTON_DOWN);
    }
    if (dPadState.left !== left) {
        dPadState.left = left;
        if (left) nes.buttonDown(1, jsnes.Controller.BUTTON_LEFT);
        else nes.buttonUp(1, jsnes.Controller.BUTTON_LEFT);
    }
    if (dPadState.right !== right) {
        dPadState.right = right;
        if (right) nes.buttonDown(1, jsnes.Controller.BUTTON_RIGHT);
        else nes.buttonUp(1, jsnes.Controller.BUTTON_RIGHT);
    }
    updateDPadVisuals();
}

function handleDPadTouch(e) {
    e.preventDefault();
    if (e.type === 'touchend' || e.type === 'touchcancel' || e.touches.length === 0) {
        setDPadState(false, false, false, false);
        return;
    }

    const touch = e.touches[0];
    const rect = dPad.getBoundingClientRect();
    const x = touch.clientX - rect.left;
    const y = touch.clientY - rect.top;
    
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;

    const dx = x - centerX;
    const dy = y - centerY;

    // Deadzone in the center
    if (Math.sqrt(dx * dx + dy * dy) < 20) {
        setDPadState(false, false, false, false);
        return;
    }

    const angle = Math.atan2(dy, dx);
    const degrees = angle * 180 / Math.PI;

    let up = false, down = false, left = false, right = false;

    if (degrees > -135 && degrees < -45) {
        up = true;
    } else if (degrees > 45 && degrees < 135) {
        down = true;
    } else if (degrees > 135 || degrees < -135) {
        left = true;
    } else if (degrees < 45 && degrees > -45) {
        right = true;
    }
    
    setDPadState(up, down, left, right);
}

dPad.addEventListener('touchstart', handleDPadTouch);
dPad.addEventListener('touchmove', handleDPadTouch);
dPad.addEventListener('touchend', handleDPadTouch);
dPad.addEventListener('touchcancel', handleDPadTouch);

// Generic button handler for A, B, Start, Select
function handleButtonTouch(e, isDown) {
    e.preventDefault();
    for (const touch of e.changedTouches) {
        let element = touch.target;
        while (element && element.id !== 'mobile-controls') {
             if (buttonMap[element.id]) {
                const { p, b } = buttonMap[element.id];
                if (nes) {
                    if (isDown) {
                        nes.buttonDown(p, b);
                    } else {
                        nes.buttonUp(p, b);
                    }
                }
                break;
            }
            element = element.parentElement;
        }
    }
}

const otherButtons = document.querySelectorAll('.action-button, .menu-button');
otherButtons.forEach(button => {
    button.addEventListener('touchstart', e => handleButtonTouch(e, true));
    button.addEventListener('touchend', e => handleButtonTouch(e, false));
    button.addEventListener('touchcancel', e => handleButtonTouch(e, false));
});


// --- ROM Loading ---
romFile.addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (!file) {
        return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
        startEmulator(e.target.result);
    };
    reader.onerror = (e) => {
        statusDiv.textContent = 'Error reading ROM file.';
        console.error('File reading error', e);
    };
    reader.readAsBinaryString(file);
});