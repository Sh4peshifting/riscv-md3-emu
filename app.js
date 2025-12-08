// SPDX-License-Identifier: CC0-1.0 OR 0BSD
import { RiscvState, RiscvMemory } from './emulator.js';
import { assemble_riscv } from './assembler.js';

const els = {
    editor: document.getElementById('source-code'),
    editorHighlight: document.getElementById('editor-highlight'),
    btnStartStop: document.getElementById('btn-start-stop'),
    btnReset: document.getElementById('btn-reset'), 
    btnDump: document.getElementById('btn-dump'),
    btnRun: document.getElementById('btn-run'),
    btnStep: document.getElementById('btn-step'),
    btnClearTerm: document.getElementById('btn-clear-term'),
    btnTheme: document.getElementById('btn-theme'),
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

    // Modal Elements
    modalDump: document.getElementById('dump-modal'),
    modalContent: document.getElementById('dump-content'),
    btnCloseModal: document.getElementById('btn-close-modal'),
    btnCloseModalAction: document.getElementById('btn-close-modal-action'),
    btnCopyDump: document.getElementById('btn-copy-dump'),
};

class UiMemory extends RiscvMemory {
    constructor(terminalEl) {
        super(1 << 20); 
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

let state = {
    mem: null,
    riscv: null,
    running: false,
    started: false,
    timer: null,
    lastRegs: new Uint32Array(32), 
    lastCsr: {},
    pcToLine: new Map(),
    dumpStr: "",
    themeMode: 'auto'
};

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

function updateView(forceReset = false) {
    if (!state.riscv) return;
    
    const dump = state.riscv.dump_state();
    
    // Highlight current line
    if (state.pcToLine.has(dump.pc)) {
        const lineNo = state.pcToLine.get(dump.pc);
        updateEditorHighlight(lineNo);
    } else {
        els.editorHighlight.style.display = 'none';
    }

    // PC Badge Color is now handled by CSS var, text content here
    els.pcBadge.textContent = `PC: ${fmtHex(dump.pc)}`;

    for (let i = 0; i < 32; i++) {
        const el = document.getElementById(`reg-x${i}`);
        const valSpan = el.querySelector('.reg-val');
        const currentVal = dump.regs[i];
        const oldVal = state.lastRegs[i];

        valSpan.textContent = fmtHex(currentVal);

        if (!forceReset && currentVal !== oldVal) {
            el.classList.add('reg-changed');
        } else {
            el.classList.remove('reg-changed');
            if (!forceReset && currentVal !== oldVal) {
                el.classList.add('reg-changed');
            }
        }
    }

    const privLabels = { 0: 'User', 3: 'Machine' };
    const privStr = `${dump.priv} (${privLabels[dump.priv] || '???'})`;
    const mppStr = `${dump.mpp} (${privLabels[dump.mpp] || '???'})`;
    
    const updateCsr = (el, valStr, key) => {
        const old = state.lastCsr[key];
        el.textContent = valStr;
        el.classList.remove('value-changed');
        if (!forceReset && valStr !== old) {
            el.classList.add('value-changed');
        }
        state.lastCsr[key] = valStr;
    };

    updateCsr(els.csrPriv, privStr, 'priv');
    updateCsr(els.csrMstatus, fmtHex(dump.priv << 11), 'mstatus');
    updateCsr(els.csrMpp, mppStr, 'mpp');
    updateCsr(els.csrMscratch, fmtHex(dump.mscratch), 'mscratch');
    updateCsr(els.csrMtvec, fmtHex(dump.mtvec), 'mtvec');
    updateCsr(els.csrMepc, fmtHex(dump.mepc), 'mepc');
    updateCsr(els.csrMtval, fmtHex(dump.mtval), 'mtval');
    updateCsr(els.csrMcause, fmtHex(dump.mcause), 'mcause');
    updateCsr(els.csrCycle, fmtHex64(dump.cycle[1], dump.cycle[0]), 'cycle');
    updateCsr(els.csrInstret, fmtHex64(dump.instret[1], dump.instret[0]), 'instret');

    state.lastRegs.set(dump.regs);
}

function updateEditorHighlight(lineNo) {
    if (!lineNo) {
        els.editorHighlight.style.display = 'none';
        return;
    }
    const lineHeight = 21; // 14px * 1.5
    const paddingTop = 12;
    const top = paddingTop + (lineNo - 1) * lineHeight - els.editor.scrollTop;
    
    els.editorHighlight.style.top = `${top}px`;
    els.editorHighlight.style.display = 'block';
}

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

    state.pcToLine = res.lineMap || new Map();
    state.dumpStr = res.dump;

    state.mem = new UiMemory(els.terminal);
    new Uint8Array(state.mem.memory).set(new Uint8Array(res.data));
    
    state.riscv = new RiscvState(state.mem);
    state.riscv.pc = res.symbols.get('_start') ?? origin;
    state.riscv.regs[2] = origin + state.mem.memory.byteLength;

    state.lastRegs.fill(0); 
    state.lastCsr = {};

    state.started = true;
    state.running = false;
    
    els.editor.disabled = true;
    els.btnStartStop.innerHTML = '<span class="material-symbols-outlined">stop_circle</span> Stop';
    els.btnStartStop.classList.replace('md-btn-filled', 'md-btn-outlined');
    els.btnRun.disabled = false;
    els.btnStep.disabled = false;
    els.btnReset.disabled = false; // Enable reset
    els.btnDump.disabled = false; // Enable dump
    
    logToTerminal('[ Started ]');
    updateView(true);
}

function stop() {
    state.running = false;
    state.started = false;
    clearTimeout(state.timer);
    state.riscv = null;
    state.mem = null;
    state.pcToLine = new Map();
    state.dumpStr = "";
    els.editorHighlight.style.display = 'none';

    els.editor.disabled = false;
    els.btnStartStop.innerHTML = '<span class="material-symbols-outlined">power_settings_new</span> Start';
    els.btnStartStop.classList.replace('md-btn-outlined', 'md-btn-filled');
    
    els.btnRun.innerHTML = '<span class="material-symbols-outlined">play_arrow</span> Run';
    els.btnRun.disabled = true;
    els.btnStep.disabled = true;
    els.btnReset.disabled = true; // Disable reset
    els.btnDump.disabled = true; // Disable dump
    
    logToTerminal('[ Stopped ]');
}

function reset() {
    if (!state.started) return;
    // Hard reset: Stop first to clear state, then immediately Start again
    stop();
    // Clear the terminal completely on reset
    els.terminal.textContent = '';
    start();
}

function step() {
    if (!state.started) return;
    const res = state.riscv.step();
    updateView(); 

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
    const STEPS_PER_BATCH = 50;

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
    updateView();
    state.timer = setTimeout(runLoop, 0);
}

function toggleRun() {
    if (state.running) {
        pause();
    } else {
        if (!state.started) return;
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

// Modal Logic
function showDump() {
    els.modalContent.textContent = state.dumpStr;
    els.modalDump.classList.remove('hidden');
}

function hideDump() {
    els.modalDump.classList.add('hidden');
}

function copyDump() {
    navigator.clipboard.writeText(state.dumpStr).then(() => {
        const originalHtml = els.btnCopyDump.innerHTML;
        els.btnCopyDump.innerHTML = '<span class="material-symbols-outlined">check</span> Copied';
        setTimeout(() => {
            els.btnCopyDump.innerHTML = originalHtml;
        }, 2000);
    });
}

// Theme Logic
const THEMES = ['auto', 'light', 'dark'];
const THEME_ICONS = {
    'auto': 'brightness_auto',
    'light': 'light_mode',
    'dark': 'dark_mode'
};

function applyTheme(mode) {
    state.themeMode = mode;
    localStorage.setItem('theme', mode);
    
    if (mode === 'auto') {
        document.documentElement.removeAttribute('data-theme');
    } else {
        document.documentElement.setAttribute('data-theme', mode);
    }
    
    const iconSpan = els.btnTheme.querySelector('span');
    iconSpan.textContent = THEME_ICONS[mode];
}

function toggleTheme() {
    const currentIdx = THEMES.indexOf(state.themeMode);
    const nextIdx = (currentIdx + 1) % THEMES.length;
    applyTheme(THEMES[nextIdx]);
}

// Event Listeners
els.btnTheme.addEventListener('click', toggleTheme);

els.editor.addEventListener('scroll', () => {
    if (state.started && state.riscv) {
        const lineNo = state.pcToLine.get(state.riscv.pc);
        if (lineNo) updateEditorHighlight(lineNo);
    }
});

els.btnStartStop.addEventListener('click', () => {
    if (state.started) stop();
    else start();
});

els.btnRun.addEventListener('click', toggleRun);

els.btnReset.addEventListener('click', () => {
   reset(); 
});

els.btnDump.addEventListener('click', showDump);
els.btnCloseModal.addEventListener('click', hideDump);
els.btnCloseModalAction.addEventListener('click', hideDump);
els.btnCopyDump.addEventListener('click', copyDump);
els.modalDump.addEventListener('click', (e) => {
    if (e.target === els.modalDump) hideDump();
});

els.btnStep.addEventListener('click', () => {
    pause();
    step();
});

els.btnClearTerm.addEventListener('click', () => {
    els.terminal.textContent = '';
});

// Init
initRegGrid();
applyTheme(localStorage.getItem('theme') || 'auto');