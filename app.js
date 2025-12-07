// SPDX-License-Identifier: CC0-1.0 OR 0BSD
import { RiscvState, RiscvMemory } from './emulator.js';
import { assemble_riscv } from './assembler.js';

// --- UI Elements ---
const els = {
    editor: document.getElementById('source-code'),
    btnRun: document.getElementById('btn-run'),
    btnStep: document.getElementById('btn-step'),
    btnReset: document.getElementById('btn-reset'),
    btnClearTerm: document.getElementById('btn-clear-term'),
    checkPause: document.getElementById('check-pause'),
    regContainer: document.getElementById('registers-container'),
    terminal: document.getElementById('terminal-output'),
    statusMsg: document.getElementById('status-message'),
    pcBadge: document.getElementById('pc-badge')
};

// --- Memory Implementation for UI ---
class UiMemory extends RiscvMemory {
    constructor(terminalEl) {
        super(1 << 20); // 1MB Memory
        this.terminalEl = terminalEl;
        this.decoder = new TextDecoder();
    }

    read(address, width) {
        // Handle Magic MMIO address for output
        if (address === 0x10000000) {
            return (width === 4 || width === 1) ? 0 : null;
        }
        return super.read(address, width);
    }

    write(address, width, data) {
        if (address === 0x10000000) {
            if (width === 4 || width === 1) {
                const char = this.decoder.decode(new Uint8Array([data & 0xff]));
                this.terminalEl.textContent += char;
                this.terminalEl.scrollTop = this.terminalEl.scrollHeight;
                return true;
            }
            return null;
        }
        return super.write(address, width, data);
    }
}

// --- State Management ---
let state = {
    mem: null,
    riscv: null,
    running: false,
    started: false,
    timer: null,
    oldRegs: null // For highlighting changes
};

// --- Constants ---
const REG_NAMES = "zero ra sp gp tp t0 t1 t2 s0 s1 a0 a1 a2 a3 a4 a5 a6 a7 s2 s3 s4 s5 s6 s7 s8 s9 s10 s11 t3 t4 t5 t6".split(' ');
const CAUSES = new Map([
    [0x00, "Instruction address misaligned"],
    [0x01, "Instruction access fault"],
    [0x02, "Illegal instruction"],
    [0x03, "Breakpoint"],
    [0x05, "Load access fault"],
    [0x07, "Store/AMO access fault"],
    [0x08, "User ECALL"],
    [0x0b, "Machine ECALL"]
]);

// --- Helper Functions ---
const fmtHex = (x) => `0x${(x >>> 0).toString(16).padStart(8, '0')}`;

function showError(msg) {
    els.statusMsg.textContent = msg;
    els.statusMsg.classList.remove('hidden');
}

function clearError() {
    els.statusMsg.classList.add('hidden');
    els.statusMsg.textContent = '';
}

function initRegGrid() {
    els.regContainer.innerHTML = '';
    // Generate boxes for x0-x31
    for (let i = 0; i < 32; i++) {
        const div = document.createElement('div');
        div.className = 'reg-item';
        div.id = `reg-x${i}`;
        div.innerHTML = `
            <span class="reg-name">x${i} (${REG_NAMES[i]})</span>
            <span class="reg-val">0x00000000</span>
        `;
        els.regContainer.appendChild(div);
    }
    // Add CSRs explicitly if needed, or append them
}

function updateRegView() {
    if (!state.riscv) return;
    
    const currentRegs = state.riscv.regs;
    els.pcBadge.textContent = `PC: ${fmtHex(state.riscv.pc)}`;

    for (let i = 0; i < 32; i++) {
        const el = document.getElementById(`reg-x${i}`);
        const valSpan = el.querySelector('.reg-val');
        const newVal = currentRegs[i];
        const valStr = fmtHex(newVal);

        if (valSpan.textContent !== valStr) {
            valSpan.textContent = valStr;
            el.classList.add('reg-changed');
            setTimeout(() => el.classList.remove('reg-changed'), 500);
        }
    }
}

// --- Emulator Actions ---

function stopEmulator() {
    state.running = false;
    state.started = false;
    clearTimeout(state.timer);
    
    els.editor.disabled = false;
    els.btnRun.innerHTML = '<span class="material-symbols-outlined">play_arrow</span> Run';
    els.btnStep.disabled = true;
    els.btnReset.disabled = true;
    state.riscv = null;
    state.mem = null;
    
    // Clear visualization
    updateRegView(); // Will just keep last state or can be cleared
}

function startEmulator() {
    clearError();
    const code = els.editor.value;
    const origin = 0x40000000;
    
    const res = assemble_riscv(code, origin);
    
    if (res.type === 'errors') {
        const firstErr = res.errors[0];
        showError(`Line ${firstErr.lineno}: ${firstErr.message}`);
        return false;
    }

    // Initialize Memory & CPU
    state.mem = new UiMemory(els.terminal);
    // Load program
    new Uint8Array(state.mem.memory).set(new Uint8Array(res.data));
    
    state.riscv = new RiscvState(state.mem);
    state.riscv.pc = res.symbols.get('_start') ?? origin;
    state.riscv.regs[2] = origin + state.mem.memory.byteLength; // SP init

    state.started = true;
    els.editor.disabled = true;
    els.btnStep.disabled = false;
    els.btnReset.disabled = false;
    
    updateRegView();
    return true;
}

function step() {
    if (!state.started) return;

    const res = state.riscv.step();
    updateRegView();

    if (res.type === 'exception') {
        const causeStr = CAUSES.get(res.cause) || `Unknown (${res.cause})`;
        showError(`Exception: ${causeStr} at PC=${fmtHex(res.epc)}`);
        if (els.checkPause.checked) {
            pause();
        }
    } else if (res.type === 'stop') {
        showError("Program halted (ebreak)");
        pause();
    }
}

function runLoop() {
    const STEPS_PER_LOOP = 100; // Speed control
    if (!state.running) return;

    for (let i = 0; i < STEPS_PER_LOOP; i++) {
        const res = state.riscv.step();
        
        if (res.type === 'exception') {
            updateRegView();
            const causeStr = CAUSES.get(res.cause) || `Unknown (${res.cause})`;
            showError(`Exception: ${causeStr} at PC=${fmtHex(res.epc)}`);
            if (els.checkPause.checked) pause();
            return;
        } else if (res.type === 'stop') {
            updateRegView();
            showError("Program halted (ebreak)");
            pause();
            return;
        }
    }
    
    updateRegView();
    state.timer = setTimeout(runLoop, 0);
}

function toggleRun() {
    if (state.running) {
        pause();
    } else {
        if (!state.started) {
            if (!startEmulator()) return;
        }
        state.running = true;
        els.btnRun.innerHTML = '<span class="material-symbols-outlined">pause</span> Pause';
        els.btnStep.disabled = true;
        runLoop();
    }
}

function pause() {
    state.running = false;
    clearTimeout(state.timer);
    els.btnRun.innerHTML = '<span class="material-symbols-outlined">play_arrow</span> Run';
    els.btnStep.disabled = false;
}

// --- Event Listeners ---

els.btnRun.addEventListener('click', toggleRun);

els.btnStep.addEventListener('click', () => {
    if (!state.started) {
        if (!startEmulator()) return;
    }
    step();
});

els.btnReset.addEventListener('click', () => {
    stopEmulator();
    els.terminal.textContent = '';
    clearError();
    initRegGrid();
});

els.btnClearTerm.addEventListener('click', () => {
    els.terminal.textContent = '';
});

// Init
initRegGrid();