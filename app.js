import { RiscvState, RiscvMemory } from './emulator.js';
import { assemble_riscv } from './assembler.js';

// --- UI Elements ---
const els = {
    editor: document.getElementById('source-code'),
    btnStartStop: document.getElementById('btn-start-stop'),
    btnRun: document.getElementById('btn-run'),
    btnStep: document.getElementById('btn-step'),
    btnClearTerm: document.getElementById('btn-clear-term'),
    checkPause: document.getElementById('check-pause'),
    regContainer: document.getElementById('registers-container'),
    terminal: document.getElementById('terminal-output'),
    statusMsg: document.getElementById('status-message'),
    pcBadge: document.getElementById('pc-badge'),
    
    // CSR Elements
    csrPriv: document.getElementById('csr-priv'),
    csrMstatus: document.getElementById('csr-mstatus'),
    csrMpp: document.getElementById('csr-mpp'),
    csrMscratch: document.getElementById('csr-mscratch'),
    csrMtvec: document.getElementById('csr-mtvec'),
    csrMepc: document.getElementById('csr-mepc'),
    csrMtval: document.getElementById('csr-mtval'),
    csrMcause: document.getElementById('csr-mcause'),
    csrCycle: document.getElementById('csr-cycle'),
    csrInstret: document.getElementById('csr-instret'),
};

// --- Memory Implementation ---
class UiMemory extends RiscvMemory {
    constructor(terminalEl) {
        super(1 << 20); // 1MB Memory
        this.terminalEl = terminalEl;
        this.decoder = new TextDecoder();
    }

    read(address, width) {
        if (address === 0x10000000) return (width === 4 || width === 1) ? 0 : null;
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

    lastRegs: new Uint32Array(32), 
    lastCsr: {} 
};

// --- Constants & Helpers ---
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

const fmtHex = (x) => `0x${(x >>> 0).toString(16).padStart(8, '0')}`;
const fmtHex64 = (hi, lo) => `0x${(hi >>> 0).toString(16).padStart(8, '0')}_${(lo >>> 0).toString(16).padStart(8, '0')}`;

function logToTerminal(msg) {
    els.terminal.textContent += msg + '\n';
    els.terminal.scrollTop = els.terminal.scrollHeight;
}

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
    for (let i = 0; i < 32; i++) {
        const div = document.createElement('div');
        div.className = 'reg-item';
        div.id = `reg-x${i}`;
        div.innerHTML = `
            <span class="reg-name">x${i} ${REG_NAMES[i]}</span>
            <span class="reg-val">0x00000000</span>
        `;
        els.regContainer.appendChild(div);
    }
}

// --- View Updates ---

function updateView(forceReset = false) {
    if (!state.riscv) return;
    
    const dump = state.riscv.dump_state();
    
    // 1. Update PC
    els.pcBadge.textContent = `PC: ${fmtHex(dump.pc)}`;

    // 2. Update General Purpose Registers (GPR)
    for (let i = 0; i < 32; i++) {
        const el = document.getElementById(`reg-x${i}`);
        const valSpan = el.querySelector('.reg-val');
        const currentVal = dump.regs[i];
        const oldVal = state.lastRegs[i];

        valSpan.textContent = fmtHex(currentVal);

        // Logic: Highlight if value is different from previous step
        // Keep highlighted until it matches again (unlikely) or just stays highlighted if changed recently?
        // User requested: "always highlight if changed compared to last"
        if (!forceReset && currentVal !== oldVal) {
            el.classList.add('reg-changed');
        } else {
            // Only remove highlight if it's strictly equal to previous, 
            // BUT usually in emulators, "Changed" means "Changed in the last executed instruction".
            // So we clear all highlights first usually, then apply new ones.
            // However, to make it "stable", we compare to `state.lastRegs`.
            // If we want the highlight to persist across multiple steps ONLY if it keeps changing, that's one thing.
            // If we want it to persist as "this register was modified recently", that's another.
            // Standard behavior: Reset highlight class, then apply if diff.
            el.classList.remove('reg-changed');
            if (!forceReset && currentVal !== oldVal) {
                el.classList.add('reg-changed');
            }
        }
    }

    // 3. Update CSRs
    const privLabels = { 0: 'User', 3: 'Machine' };
    const privStr = `${dump.priv} (${privLabels[dump.priv] || '???'})`;
    const mppStr = `${dump.mpp} (${privLabels[dump.mpp] || '???'})`;
    
    // Helper to update text and highlight change
    const updateCsr = (el, valStr, key) => {
        const old = state.lastCsr[key];
        el.textContent = valStr;
        el.classList.remove('value-changed');
        if (!forceReset && valStr !== old) {
            el.classList.add('value-changed');
        }
        state.lastCsr[key] = valStr; // Update cache for next time
    };

    updateCsr(els.csrPriv, privStr, 'priv');
    updateCsr(els.csrMstatus, fmtHex(dump.priv << 11), 'mstatus'); // Approximate from mpp
    updateCsr(els.csrMpp, mppStr, 'mpp');
    
    updateCsr(els.csrMscratch, fmtHex(dump.mscratch), 'mscratch');
    updateCsr(els.csrMtvec, fmtHex(dump.mtvec), 'mtvec');
    updateCsr(els.csrMepc, fmtHex(dump.mepc), 'mepc');
    updateCsr(els.csrMtval, fmtHex(dump.mtval), 'mtval');
    updateCsr(els.csrMcause, fmtHex(dump.mcause), 'mcause');
    
    updateCsr(els.csrCycle, fmtHex64(dump.cycle[1], dump.cycle[0]), 'cycle');
    updateCsr(els.csrInstret, fmtHex64(dump.instret[1], dump.instret[0]), 'instret');

    // Update 'Last State' for next comparison
    state.lastRegs.set(dump.regs);
}

// --- Logic ---

function start() {
    clearError();
    const code = els.editor.value;
    const origin = 0x40000000;
    
    const res = assemble_riscv(code, origin);
    
    if (res.type === 'errors') {
        const firstErr = res.errors[0];
        showError(`Assemble Error (Line ${firstErr.lineno}): ${firstErr.message}`);
        return;
    }

    state.mem = new UiMemory(els.terminal);
    new Uint8Array(state.mem.memory).set(new Uint8Array(res.data));
    
    state.riscv = new RiscvState(state.mem);
    state.riscv.pc = res.symbols.get('_start') ?? origin;
    state.riscv.regs[2] = origin + state.mem.memory.byteLength; // SP

    // Initialize "Last State" to zeros so initial load highlights changes (optional, or sync to current)
    state.lastRegs.fill(0); 
    state.lastCsr = {};

    state.started = true;
    state.running = false;
    
    // Update UI Controls
    els.editor.disabled = true;
    els.btnStartStop.innerHTML = '<span class="material-symbols-outlined">stop_circle</span> Stop';
    els.btnStartStop.classList.replace('md-btn-filled', 'md-btn-outlined');
    els.btnRun.disabled = false;
    els.btnStep.disabled = false;
    
    logToTerminal('[ Started ]');
    updateView(true); // true = force reset highlights (show initial state clean)
}

function stop() {
    state.running = false;
    state.started = false;
    clearTimeout(state.timer);
    
    state.riscv = null;
    state.mem = null;

    // UI Reset
    els.editor.disabled = false;
    els.btnStartStop.innerHTML = '<span class="material-symbols-outlined">power_settings_new</span> Start';
    els.btnStartStop.classList.replace('md-btn-outlined', 'md-btn-filled');
    
    els.btnRun.innerHTML = '<span class="material-symbols-outlined">play_arrow</span> Run';
    els.btnRun.disabled = true;
    els.btnStep.disabled = true;
    
    logToTerminal('[ Stopped ]');
}

function step() {
    if (!state.started) return;

    // Cache current state before stepping to allow 'diff' in updateView
    // Note: updateView actually handles the diff by comparing riscv.dump_state() vs state.lastRegs
    // So we just execute step.
    
    const res = state.riscv.step();
    updateView(); // This will compare new state vs lastRegs, highlight diffs, then update lastRegs

    if (res.type === 'exception') {
        const causeStr = CAUSES.get(res.cause) || `Unknown (${res.cause})`;
        showError(`Exception: ${causeStr} @PC=${fmtHex(res.epc)}`);
        if (els.checkPause.checked) pause();
    } else if (res.type === 'stop') {
        showError("Program halted (ebreak)");
        pause();
    }
}

function runLoop() {
    if (!state.running) return;
    const STEPS_PER_BATCH = 50; // Speed adjustment

    for (let i = 0; i < STEPS_PER_BATCH; i++) {
        const res = state.riscv.step();
        
        if (res.type === 'exception') {
            updateView();
            const causeStr = CAUSES.get(res.cause) || `Unknown (${res.cause})`;
            showError(`Exception: ${causeStr}`);
            if (els.checkPause.checked) {
                pause();
                return;
            }
        } else if (res.type === 'stop') {
            updateView();
            showError("Program halted (ebreak)");
            pause();
            return;
        }
    }
    
    updateView(); // Update visuals once per batch
    state.timer = setTimeout(runLoop, 0);
}

function toggleRun() {
    if (state.running) {
        pause();
    } else {
        if (!state.started) return;
        state.running = true;
        els.btnRun.innerHTML = '<span class="material-symbols-outlined">pause</span> Pause';
        els.btnStep.disabled = true; // Disable Step while running
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

els.btnStartStop.addEventListener('click', () => {
    if (state.started) stop();
    else start();
});

els.btnRun.addEventListener('click', toggleRun);

els.btnStep.addEventListener('click', () => {
    pause(); // Safety
    step();
});

els.btnClearTerm.addEventListener('click', () => {
    els.terminal.textContent = '';
});

// Init
initRegGrid();