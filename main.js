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

// Multiplayer UI
const shareButton = document.getElementById('share-button');
const joinButton = document.getElementById('join-button');
const stopShareButton = document.getElementById('stop-share-button');
const playersDiv = document.getElementById('players');

// Mobile Multiplayer UI
const shareButtonMobile = document.getElementById('share-button-mobile');
const joinButtonMobile = document.getElementById('join-button-mobile');
const stopShareButtonMobile = document.getElementById('stop-share-button-mobile');

let imageData = canvasContext.getImageData(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
let framebuffer_u8 = new Uint8ClampedArray(imageData.data.buffer);
let framebuffer_u32 = new Uint32Array(imageData.data.buffer);

let nes = null;
let animationFrameId = null;
let lastRomFile = null;

// Multiplayer state
const room = new WebsimSocket();
let isHost = false;
let isPeer = false;
let hostId = null;
let peerControllerMap = {};
let nextControllerId = 2; // Player 1 is host, peers are 2

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
    if (!nes && !isPeer) return;

    const dst_l = event.outputBuffer.getChannelData(0);
    const dst_r = event.outputBuffer.getChannelData(1);
    const len = dst_l.length;

    // For peers, the audio buffer is filled by network events
    if (isPeer) {
        if (audio_remain() < len) {
            // buffer underrun, fill with silence
        }
    }

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

    // For hosts, send samples to peers
    if (isHost && audio_remain() > AUDIO_BUFFERING * 2) {
        const samplesToSendoL = [];
        const samplesToSendoR = [];
        const tempReadCursor = (audio_write_cursor - AUDIO_BUFFERING) & SAMPLE_MASK;
        
        for(let i = 0; i < AUDIO_BUFFERING; i++) {
            const cursor = (tempReadCursor + i) & SAMPLE_MASK;
            samplesToSendoL.push(audio_samples_L[cursor]);
            samplesToSendoR.push(audio_samples_R[cursor]);
        }
        
        room.send({
            type: 'audio-chunk',
            l: samplesToSendoL,
            r: samplesToSendoR
        });
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

    if (isHost) {
        // Using Uint8ClampedArray is more efficient than sending a huge array of numbers
        // We send every other frame to reduce network traffic.
        if(nes.ppu.fpsFrameCount % 2 === 0) {
            room.send({
                type: 'frame-update',
                // convert to a regular array for JSON serialization
                frame: Array.from(framebuffer_u8),
                echo: false // Don't send to self
            });
        }
    }
}

function main_loop(timestamp) {
    if (!nes || isPeer) {
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

function startEmulator(romData, isHostStart = false) {
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
    }
    if (audioContext && audioContext.state !== 'closed') {
        audioContext.close();
        audioContext = null;
    }

    statusDiv.textContent = 'Emulator running.';
    romLoader.classList.add('hidden');

    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const scriptNode = audioContext.createScriptProcessor(AUDIO_BUFFERING, 0, 2);
    scriptNode.onaudioprocess = audio_callback;
    scriptNode.connect(audioContext.destination);

    nes = new NES({
        onFrame: onFrame,
        onAudioSample: (isHostStart || (!isPeer && !isHost)) ? onAudioSample : null,
        sampleRate: audioContext.sampleRate,
    });
    
    // For peers, romData might be null, but we still need to init the NES object.
    // The actual frames will come from the host.
    if (romData) {
        nes.loadROM(romData);
    }
    
    if (!isPeer) { // Only host or single player runs the main loop
        lastFrameTime = 0;
        accumulator = 0;
        animationFrameId = requestAnimationFrame(main_loop);
    }
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
    if (isPeer && hostId) {
        Object.keys(KEYMAP).forEach(keyCode => {
            if (e.keyCode == keyCode) {
                const { b } = KEYMAP[keyCode];
                room.requestPresenceUpdate(hostId, {
                    type: 'controller',
                    action: isDown ? 'down' : 'up',
                    button: b,
                    // Peers always control player 2 for simplicity
                    player: 2 
                });
                e.preventDefault();
            }
        });
        return;
    }

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
const dPadButtonMap = {
    up: jsnes.Controller.BUTTON_UP,
    down: jsnes.Controller.BUTTON_DOWN,
    left: jsnes.Controller.BUTTON_LEFT,
    right: jsnes.Controller.BUTTON_RIGHT,
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

function handlePeerDPadInput(direction, isDown) {
    if (!isPeer || !hostId) return;
    const button = dPadButtonMap[direction];
    if (button) {
        room.requestPresenceUpdate(hostId, {
            type: 'controller',
            action: isDown ? 'down' : 'up',
            button,
            player: 2,
        });
    }
}

function setDPadState(up, down, left, right) {
    if (isPeer) {
        if (dPadState.up !== up) { dPadState.up = up; handlePeerDPadInput('up', up); }
        if (dPadState.down !== down) { dPadState.down = down; handlePeerDPadInput('down', down); }
        if (dPadState.left !== left) { dPadState.left = left; handlePeerDPadInput('left', left); }
        if (dPadState.right !== right) { dPadState.right = right; handlePeerDPadInput('right', right); }
        updateDPadVisuals();
        return;
    }
    
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
    const dist_sq = dx * dx + dy * dy;

    // Make the entire circular area active, with a small deadzone
    if (dist_sq > (centerX * centerX)) {
        // Finger is outside the d-pad circle, release all
        setDPadState(false, false, false, false);
        return;
    }
    
    if (dist_sq < (20 * 20)) {
        // Deadzone in the center
        setDPadState(false, false, false, false);
        return;
    }

    const angle = Math.atan2(dy, dx) * 180 / Math.PI;

    let up = false, down = false, left = false, right = false;

    // 8-way directional logic, with 45 degree sectors
    if (angle > -67.5 && angle <= -22.5) { // Up-Right
        up = true; right = true;
    } else if (angle > -112.5 && angle <= -67.5) { // Up
        up = true;
    } else if (angle > -157.5 && angle <= -112.5) { // Up-Left
        up = true; left = true;
    } else if (angle > 157.5 || angle <= -157.5) { // Left
        left = true;
    } else if (angle > 112.5 && angle <= 157.5) { // Down-Left
        down = true; left = true;
    } else if (angle > 67.5 && angle <= 112.5) { // Down
        down = true;
    } else if (angle > 22.5 && angle <= 67.5) { // Down-Right
        down = true; right = true;
    } else if (angle > -22.5 && angle <= 22.5) { // Right
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
                if (isPeer && hostId) {
                    room.requestPresenceUpdate(hostId, {
                        type: 'controller',
                        action: isDown ? 'down' : 'up',
                        button: b,
                        player: 2
                    });
                } else if (nes) {
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
    lastRomFile = file;

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

// --- Multiplayer ---
function updatePlayerList() {
    if (!room.peers) return;
    playersDiv.innerHTML = '';
    Object.values(room.peers).forEach(peer => {
        const playerEl = document.createElement('div');
        playerEl.classList.add('player');
        
        const avatar = document.createElement('img');
        avatar.src = peer.avatarUrl;
        playerEl.appendChild(avatar);

        const username = document.createElement('span');
        username.textContent = peer.username;
        if (peer.id === room.clientId) {
            username.textContent += ' (You)';
        }
        playerEl.appendChild(username);

        if (peer.id === hostId) {
            const hostBadge = document.createElement('span');
            hostBadge.textContent = 'Host';
            hostBadge.classList.add('badge');
            playerEl.appendChild(hostBadge);
        }
        playersDiv.appendChild(playerEl);
    });
}

function stopHosting() {
    isHost = false;
    hostId = null;
    room.updateRoomState({ hostId: null, romUrl: null });
    stopShareButton.style.display = 'none';
    joinButton.style.display = 'block';
    shareButton.style.display = 'block';
    stopShareButtonMobile.style.display = 'none';
    joinButtonMobile.style.display = 'block';
    shareButtonMobile.style.display = 'block';
    statusDiv.textContent = 'Sharing stopped. Load a ROM to play.';
    if(animationFrameId) cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
    nes = null;
    romLoader.classList.remove('hidden');
    
    // reset controller mapping
    peerControllerMap = {};
    nextControllerId = 2;
}


async function initMultiplayer() {
    await room.initialize();
    statusDiv.textContent = 'Connected to multiplayer service.';

    room.subscribeRoomState((state) => {
        hostId = state.hostId;
        updatePlayerList();

        if (hostId && hostId !== room.clientId) {
            // Another user is hosting, we become a peer
            if (!isPeer) { // Only run this logic on first becoming a peer
                isPeer = true;
                isHost = false;
                statusDiv.textContent = `Joined ${room.peers[hostId]?.username || 'host'}'s game. Preparing to stream...`;

                // A peer doesn't run the emulator loop but needs an initialized NES instance
                // to handle frame and audio data. We don't have romData here, but that's okay.
                startEmulator(null); 
                romLoader.classList.add('hidden'); // Ensure loader is hidden

                shareButton.style.display = 'none';
                joinButton.style.display = 'none';
                stopShareButton.style.display = 'block'; // Acts as a "Leave" button for peers
                stopShareButton.textContent = 'Leave Game';

                // Mobile buttons
                shareButtonMobile.style.display = 'none';
                joinButtonMobile.style.display = 'none';
                stopShareButtonMobile.style.display = 'block';
                stopShareButtonMobile.textContent = 'Leave';
            }
        } else if (!hostId && isPeer) {
            // Host has left
            isPeer = false;
            statusDiv.textContent = 'Host has left the game.';
            romLoader.classList.remove('hidden');
            shareButton.style.display = 'block';
            joinButton.style.display = 'block';
            stopShareButton.style.display = 'none';
            stopShareButton.textContent = 'Stop Sharing';
            // Mobile buttons
            shareButtonMobile.style.display = 'block';
            joinButtonMobile.style.display = 'block';
            stopShareButtonMobile.style.display = 'none';
            stopShareButtonMobile.textContent = 'Stop';
            
            if (audioContext && audioContext.state !== 'closed') {
                audioContext.close();
                audioContext = null;
            }
        }
    });

    room.subscribePresence((presence) => {
        updatePlayerList();
        
        // Clean up controller mapping if a peer leaves
        const currentPeerIds = Object.keys(room.peers);
        Object.keys(peerControllerMap).forEach(peerId => {
            if(!currentPeerIds.includes(peerId)){
                delete peerControllerMap[peerId];
            }
        });
    });

    room.subscribePresenceUpdateRequests((updateRequest, fromClientId) => {
        if (isHost && updateRequest.type === 'controller') {
            const { action, button } = updateRequest;
            // All peers control player 2 for now.
            const controllerId = 2;
            
            if (action === 'down') {
                nes.buttonDown(controllerId, button);
            } else {
                nes.buttonUp(controllerId, button);
            }
        }
    });

    room.onmessage = (event) => {
        const { data, fromClientId } = event;
        if (isPeer && fromClientId === hostId) {
            switch(data.type) {
                case 'frame-update':
                    // We received a frame from the host, render it.
                    framebuffer_u8.set(data.frame);
                    canvasContext.putImageData(imageData, 0, 0);
                    break;
                case 'audio-chunk':
                    // we received audio from the host, buffer it.
                    for(let i=0; i<data.l.length; i++) {
                        audio_samples_L[audio_write_cursor] = data.l[i];
                        audio_samples_R[audio_write_cursor] = data.r[i];
                        audio_write_cursor = (audio_write_cursor + 1) & SAMPLE_MASK;
                    }
                    break;
            }
        }
    };
    
    updatePlayerList();

    async function handleShare() {
        if (!nes || !lastRomFile) {
            alert('Please load a ROM file first!');
            return;
        }

        statusDiv.textContent = 'Uploading ROM for sharing...';
        try {
            const romUrl = await window.websim.upload(lastRomFile);
            isHost = true;
            hostId = room.clientId;
            room.updateRoomState({ hostId: room.clientId, romUrl });

            statusDiv.textContent = 'Sharing game! Others can now join.';
            shareButton.style.display = 'none';
            joinButton.style.display = 'none';
            stopShareButton.style.display = 'block';
            
            // Mobile buttons
            shareButtonMobile.style.display = 'none';
            joinButtonMobile.style.display = 'none';
            stopShareButtonMobile.style.display = 'block';
            stopShareButtonMobile.textContent = 'Stop';

            updatePlayerList();

        } catch(e) {
            statusDiv.textContent = 'Error sharing ROM.';
            console.error('Failed to upload ROM', e);
        }
    }

    function handleJoin() {
        // Just being in the room is enough, the subscription will handle joining a host.
        statusDiv.textContent = "Looking for a game to join...";
        joinButton.disabled = true;
        joinButtonMobile.disabled = true;

        if (hostId && hostId !== room.clientId) {
             statusDiv.textContent = `Joined ${room.peers[hostId]?.username || 'host'}'s game.`;
        } else {
             statusDiv.textContent = "No game found. Why not share your own?";
             setTimeout(() => {
                if(!isPeer) { // re-enable if we didn't find a game
                    joinButton.disabled = false;
                    joinButtonMobile.disabled = false;
                    statusDiv.textContent = "Please load a ROM to start.";
                }
             }, 3000)
        }
    }

    function handleStop() {
        if (isHost) {
            stopHosting();
        } else if (isPeer) {
            // "Leave" the game
            isPeer = false;
            hostId = null;
            // This client doesn't need to clear room state.
            stopShareButton.style.display = 'none';
            joinButton.style.display = 'block';
            shareButton.style.display = 'block';
            
            // Mobile buttons
            stopShareButtonMobile.style.display = 'none';
            joinButtonMobile.style.display = 'block';
            shareButtonMobile.style.display = 'block';
            stopShareButtonMobile.textContent = 'Stop';

            statusDiv.textContent = 'You have left the game.';
            romLoader.classList.remove('hidden');
        }
    }

    shareButton.addEventListener('click', handleShare);
    shareButtonMobile.addEventListener('click', handleShare);
    
    joinButton.addEventListener('click', handleJoin);
    joinButtonMobile.addEventListener('click', handleJoin);

    stopShareButton.addEventListener('click', handleStop);
    stopShareButtonMobile.addEventListener('click', handleStop);
}

initMultiplayer();