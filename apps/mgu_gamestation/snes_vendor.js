'use strict';
/* jssnes SNES / MIT - original source embedded below; see corresponding license. */
(function () {
var registry = Object.create(null), cache = Object.create(null);
// Isolate upstream diagnostic globals; Node8 does not expose globalThis.
var globalThis = Object.create(null);
// Upstream emits per-instruction debug logs; silence them in the game loop.
var console = {log:function(){},warn:function(){},error:function(){},trace:function(){}};
function load(id) { if (!registry[id]) throw Error("Missing core module: " + id);
if (cache[id]) return cache[id].exports; var m={exports:{}}; cache[id]=m;
registry[id](m,m.exports,function(p){var parts=id.split("/");parts.pop();
p.split("/").forEach(function(part){if(part==="..")parts.pop();else if(part!==".")parts.push(part);});
return load(parts.join("/").replace(/\.js$/, ""));});return m.exports;}

registry['CPU'] = function(module,exports,require) {
class CPU {
  constructor(bus) {
    this.bus = bus;

    // Registers
    this.A = 0; // Accumulator (16-bit)
    this.X = 0; // Index X (16-bit)
    this.Y = 0; // Index Y (16-bit)
    this.SP = 0; // Stack Pointer (16-bit)
    this.DP = 0; // Direct Page (16-bit)
    this.DB = 0; // Data Bank (8-bit)
    this.PB = 0; // Program Bank (8-bit)
    this.PC = 0; // Program Counter (16-bit)

    // Status Register (P) flags
    this.P = {
      C: 0, // Carry
      Z: 0, // Zero
      I: 1, // IRQ Disable
      D: 0, // Decimal
      X: 1, // Index register select (0=16-bit, 1=8-bit) - Native mode only
      M: 1, // Memory/Accumulator select (0=16-bit, 1=8-bit) - Native mode only
      V: 0, // Overflow
      N: 0, // Negative
      E: 1  // Emulation mode (1=6502, 0=Native 65816)
    };

    this.cycles = 0;
    this.stopped = false;
    this.waiting = false;

    // Ring buffer of recently executed instructions, used to print a trace
    // when the CPU hits an unrecoverable error (e.g. invalid BRK vector).
    this.traceSize = 32;
    this.trace = [];
  }

  // Dump the recent-instruction ring buffer to the console (most recent last).
  dumpTrace() {
    const fr = globalThis._snesFrame || 0;
    console.error(`[CPU trace] frame=${fr} last ${this.trace.length} instructions (oldest first):`);
    for (const t of this.trace) {
      console.error(`  ${t.pb.toString(16).padStart(2, '0')}:${t.pc.toString(16).padStart(4, '0')} op=${t.op.toString(16).padStart(2, '0')} A=${t.a.toString(16).padStart(4, '0')} X=${t.x.toString(16).padStart(4, '0')} Y=${t.y.toString(16).padStart(4, '0')} SP=${t.sp.toString(16).padStart(4, '0')} DP=${t.dp.toString(16).padStart(4, '0')} DB=${t.db.toString(16).padStart(2, '0')} E=${t.e} M=${t.m}`);
    }
  }

  // --- Helpers ---
  read(addr) { return this.bus.read(addr); }
  write(addr, val) { this.bus.write(addr, val); }

  // Read word based on current settings (little endian)
  readWord(addr) {
    const lo = this.read(addr);
    const hi = this.read((addr + 1) & 0xFFFFFF);
    // Debug for APU port double-read
    if (addr === 0x2140) {
        // console.log(`readWord($2140) -> lo=${lo.toString(16)} hi=${hi.toString(16)}`);
    }
    return (hi << 8) | lo;
  }

  // Write word (little endian)
  writeWord(addr, val) {
    this.write(addr, val & 0xFF);
    this.write((addr + 1) & 0xFFFFFF, (val >> 8) & 0xFF);
  }

  // Push/Pop Stack
  push(val) {
    this.write(this.SP, val);
    this.SP = (this.SP - 1) & 0xFFFF;
    if (this.P.E && (this.SP & 0xFF00) !== 0x0100) this.SP = (this.SP & 0xFF) | 0x0100; // Wrap in emulation mode
  }

  pop() {
    this.SP = (this.SP + 1) & 0xFFFF;
    if (this.P.E && (this.SP & 0xFF00) !== 0x0100) this.SP = (this.SP & 0xFF) | 0x0100;
    return this.read(this.SP);
  }

  pushWord(val) {
    this.push((val >> 8) & 0xFF);
    this.push(val & 0xFF);
  }

  popWord() {
    const lo = this.pop();
    const hi = this.pop();
    return (hi << 8) | lo;
  }

  // Set flags based on value
  setZN(val, is16bit) {
    if (is16bit) {
      this.P.Z = ((val & 0xFFFF) === 0) ? 1 : 0;
      this.P.N = (val & 0x8000) ? 1 : 0;
    } else {
      this.P.Z = ((val & 0xFF) === 0) ? 1 : 0;
      this.P.N = (val & 0x80) ? 1 : 0;
    }
  }

  // --- Fetch ---
  fetchByte() {
    const val = this.read((this.PB << 16) | this.PC);
    this.PC = (this.PC + 1) & 0xFFFF;
    return val;
  }

  fetchWord() {
    const lo = this.fetchByte();
    const hi = this.fetchByte();
    return (hi << 8) | lo;
  }

  reset() {
    this.P.E = 1; // Start in emulation mode
    this.P.M = 1;
    this.P.X = 1;
    this.P.I = 1;
    this.P.D = 0;
    this.DB = 0x00;
    this.PB = 0x00;
    this.SP = 0x01FF; // Stack starts at 0x1FF in emulation mode
    this.DP = 0x0000;

    // Read reset vector from 0xFFFC in bank 0
    const vectorLo = this.bus.read(0xFFFC);
    const vectorHi = this.bus.read(0xFFFD);
    this.PC = (vectorHi << 8) | vectorLo;

    console.log(`Debug CPU check at Reset: read(0xFFFE)=${this.bus.read(0xFFFE).toString(16)}, read(0xFFE6)=${this.bus.read(0xFFE6).toString(16)}`);

    if (this.PC === 0 || this.PC === 0xFFFF) {
        console.error("WARNING: Invalid Reset Vector. Check ROM loading or mapping.");
        this.stopped = true; // Stop immediately
        throw new Error("Invalid Reset Vector");
    }

    // Clear pending interrupts and state flags
    this.nmiPending = false;
    this.irqPending = false;
    this.stopped = false;
    this.waiting = false;
    this.A = 0; this.X = 0; this.Y = 0;

    console.log(`CPU Reset. Vector: 0x${vectorHi.toString(16)}${vectorLo.toString(16)} -> PC: 0x${this.PC.toString(16).toUpperCase()}`);

    if (this.PC === 0 || this.PC === 0xFFFF) {
        console.error("WARNING: Invalid Reset Vector. Check ROM loading or mapping.");
    }

    this.cycles = 0;
  }

  nmi() {
      // NMI Logic
      // console.log(`[CPU] NMI Triggered at ${this.PB.toString(16).padStart(2,'0')}:${this.PC.toString(16).padStart(4,'0')}`);

      this.P.D = 0; // Decimal mode cleared on both E and Native

      if (this.P.E) {
          // Emulation Mode (6502)
          this.push((this.PC >> 8) & 0xFF);
          this.push(this.PC & 0xFF);
          let p = 0;
          p |= this.P.N ? 0x80 : 0;
          p |= this.P.V ? 0x40 : 0;
          p |= this.P.M ? 0x20 : 0; // Unused in E mode? Always 1?
          p |= this.P.D ? 0x08 : 0;
          p |= this.P.I ? 0x04 : 0;
          p |= this.P.Z ? 0x02 : 0;
          p |= this.P.C ? 0x01 : 0;
          this.push(p);

          this.P.I = 1;

          const lo = this.read(0xFFFA);
          const hi = this.read(0xFFFB);
          this.PC = (hi << 8) | lo;
          this.PB = 0; // Bank 0 constrained in E mode
      } else {
          // Native Mode (65816)
          this.push(this.PB);
          this.push((this.PC >> 8) & 0xFF);
          this.push(this.PC & 0xFF);

          let p = 0;
          p |= this.P.N ? 0x80 : 0;
          p |= this.P.V ? 0x40 : 0;
          p |= this.P.M ? 0x20 : 0;
          p |= this.P.X ? 0x10 : 0;
          p |= this.P.D ? 0x08 : 0;
          p |= this.P.I ? 0x04 : 0;
          p |= this.P.Z ? 0x02 : 0;
          p |= this.P.C ? 0x01 : 0;
          this.push(p);

          this.P.I = 1;

          const lo = this.read(0xFFEA);
          const hi = this.read(0xFFEB);
          this.PC = (hi << 8) | lo;
          this.PB = 0x00;
      }
      this.nmiPending = false;
      this.waiting = false; // Wake up from WAI
      this.cycles += this.P.E ? 7 : 8;
  }

  irq() {
      // IRQ Logic
      // console.log(`[CPU] IRQ Triggered at ${this.PB.toString(16)}:${this.PC.toString(16)}`);

      this.P.D = 0;

      if (this.P.E) {
          // Emulation Mode (6502)
          this.push((this.PC >> 8) & 0xFF);
          this.push(this.PC & 0xFF);

          let p = 0;
          p |= this.P.N ? 0x80 : 0;
          p |= this.P.V ? 0x40 : 0;
          p |= this.P.M ? 0x20 : 0;
          p |= this.P.D ? 0x08 : 0;
          p |= this.P.I ? 0x04 : 0;
          p |= this.P.Z ? 0x02 : 0;
          p |= this.P.C ? 0x01 : 0;
          this.push(p);

          this.P.I = 1;

          const lo = this.read(0xFFFE);
          const hi = this.read(0xFFFF);
          this.PC = (hi << 8) | lo;
          this.PB = 0;
      } else {
          // Native Mode (65816)
          this.push(this.PB);
          this.push((this.PC >> 8) & 0xFF);
          this.push(this.PC & 0xFF);

          let p = 0;
          p |= this.P.N ? 0x80 : 0;
          p |= this.P.V ? 0x40 : 0;
          p |= this.P.M ? 0x20 : 0;
          p |= this.P.X ? 0x10 : 0;
          p |= this.P.D ? 0x08 : 0;
          p |= this.P.I ? 0x04 : 0;
          p |= this.P.Z ? 0x02 : 0;
          p |= this.P.C ? 0x01 : 0;
          this.push(p);

          this.P.I = 1;

          const lo = this.read(0xFFEE);
          const hi = this.read(0xFFEF);
          this.PC = (hi << 8) | lo;
          this.PB = 0x00;
      }
      this.irqPending = false;
      this.waiting = false;
        this.cycles += this.P.E ? 7 : 8;
  }

  checkInterrupts() {
      if (this.nmiPending) {
          this.nmi();
          return;
      }
      if (this.irqPending && !this.P.I) {
          this.irq();
      }
  }

  // Debug tracer
  debugTrace() {
      if (this.cycles < 500000) { // Limit trace
          // Usually console.log is too slow for realtime emulation
          // Just verify PC movement
          // console.log(`${this.PB.toString(16).padStart(2,'0')}:${this.PC.toString(16).padStart(4,'0')}`);
      }
  }

  step() {
    const prevCycles = this.cycles;

    // Handle Wait State (WAI)
    if (this.waiting) {
        this.checkInterrupts();

        // WAI wakes up on IRQ even if interrupts are disabled (I = 1)
        if (this.irqPending && this.P.I) {
            this.waiting = false;
        }

        if (this.waiting) {
            this.cycles++;
            return 1; // Consume 1 cycle while waiting
        }
    }

    // Handle Stop State (STP)
    if (this.stopped) {
      this.cycles++;
      return this.cycles - prevCycles; // Stuck strictly, but time still advances
    }

    // Interrupts are checked after execute() below (65816: NMI sampled at END of instruction)

    // this.debugTrace(); // Uncomment if needed

    const opPC = this.PC;
    const opPB = this.PB;
    this._opPC = opPC; // expose for watchpoints
    this._opPB = opPB;

    const opcode = this.fetchByte();

    this.cycles++;

    this.execute(opcode, opPC, opPB);

    // Check interrupts AFTER instruction completes (65816: NMI edge-triggered, sampled at end of instruction)
    this.checkInterrupts();

    return this.cycles - prevCycles;
  }

  // --- Addressing Modes ---
  // Returns effective address or value depending on instruction need
  // For simplicity, these will return the effective 24-bit address

  // In emulation mode, old direct-page addressing wraps within page when DL=0.
  dpAddrOld(offset, index = 0) {
    if (this.P.E && (this.DP & 0xFF) === 0) {
      return ((this.DP & 0xFF00) | ((offset + index) & 0xFF)) & 0xFFFF;
    }
    return (this.DP + offset + index) & 0xFFFF;
  }

  // New 65816 addressing/instructions do not use emulation direct-page wrap.
  dpAddrNew(offset, index = 0) {
    return (this.DP + offset + index) & 0xFFFF;
  }

  // Absolute: 16-bit address in current DB (or 0 for some)
  addr_abs() {
    const offset = this.fetchWord();
    return (this.DB << 16) | offset;
  }

  // Absolute Long: 24-bit address
  addr_absl() {
    const offset = this.fetchWord();
    const bank = this.fetchByte();
    return (bank << 16) | offset;
  }

  // Direct Page: 8-bit offset from DP register
  addr_dp() {
    const offset = this.fetchByte();
    return this.dpAddrOld(offset); // Bank 0 implicit
  }

  // Direct Page Indirect: (dp)
  addr_dp_ind() {
    const offset = this.fetchByte();
    const dpAddr = this.dpAddrOld(offset);
    const addrLo = this.read(dpAddr); // Usually in bank 0
    const addrHi = this.read(this.dpAddrOld(offset, 1));
    return (this.DB << 16) | (addrHi << 8) | addrLo;
  }

  // Absolute X-indexed
  addr_abs_x() {
    const base = this.fetchWord();
    const addr = (base + this.X) & 0xFFFF; // Wrap within bank? Or cross? 65816 crosses page usually
    return (this.DB << 16) | addr;
  }

  addr_abs_x_info() {
    const base = this.fetchWord();
    const indexed = (base + this.X) & 0xFFFF;
    return {
      addr: (this.DB << 16) | indexed,
      pageCrossed: ((base ^ indexed) & 0xFF00) !== 0,
    };
  }

  // Absolute Y-indexed
  addr_abs_y() {
    const base = this.fetchWord();
    const addr = (base + this.Y) & 0xFFFF;
    return (this.DB << 16) | addr;
  }

  addr_abs_y_info() {
    const base = this.fetchWord();
    const indexed = (base + this.Y) & 0xFFFF;
    return {
      addr: (this.DB << 16) | indexed,
      pageCrossed: ((base ^ indexed) & 0xFF00) !== 0,
    };
  }

  // Direct Page Indexed X
  addr_dp_x() {
    const offset = this.fetchByte();
    return this.dpAddrOld(offset, this.X);
  }

  // Direct Page Indexed Y
  addr_dp_y() {
    const offset = this.fetchByte();
    return this.dpAddrOld(offset, this.Y);
  }

  // Direct Page Indirect Indexed X (d,x)
  addr_dp_ind_x() {
    const offset = this.fetchByte();
    const ptrAddr = this.dpAddrOld(offset, this.X);
    const lo = this.read(ptrAddr);
    const hi = this.read(this.dpAddrOld(offset, this.X + 1));
    return (this.DB << 16) | (hi << 8) | lo;
  }

  // Direct Page Indirect Indexed Y (d),y
  addr_dp_ind_y() {
    const offset = this.fetchByte();
    const ptrAddr = this.dpAddrOld(offset);
    const lo = this.read(ptrAddr);
    const hi = this.read(this.dpAddrOld(offset, 1));
    const addr = (hi << 8) | lo;
    return (this.DB << 16) | ((addr + this.Y) & 0xFFFF);
  }

  addr_dp_ind_y_info() {
    const offset = this.fetchByte();
    const ptrAddr = this.dpAddrOld(offset);
    const lo = this.read(ptrAddr);
    const hi = this.read(this.dpAddrOld(offset, 1));
    const base = (hi << 8) | lo;
    const indexed = (base + this.Y) & 0xFFFF;
    return {
      addr: (this.DB << 16) | indexed,
      pageCrossed: ((base ^ indexed) & 0xFF00) !== 0,
    };
  }

  // Direct Page Indirect Long [d]
  addr_dp_ind_long() {
    const offset = this.fetchByte();
    const ptrAddr = this.dpAddrNew(offset);
    const lo = this.read(ptrAddr);
    const hi = this.read(this.dpAddrNew(offset, 1));
    const bank = this.read(this.dpAddrNew(offset, 2));
    return (bank << 16) | (hi << 8) | lo;
  }

  // Direct Page Indirect Long Indexed Y [d],y
  addr_dp_ind_long_y() {
    const offset = this.fetchByte();
    const ptrAddr = this.dpAddrNew(offset);
    const lo = this.read(ptrAddr);
    const hi = this.read(this.dpAddrNew(offset, 1));
    const bank = this.read(this.dpAddrNew(offset, 2));
    const addr = (bank << 16) | (hi << 8) | lo;
    return (addr + this.Y) & 0xFFFFFF;
  }

  // Stack Relative (d,s)
  addr_sr() {
    const offset = this.fetchByte();
    return (this.SP + offset) & 0xFFFF;
  }

  // Stack Relative Indirect Indexed Y (d,s),y
  addr_sr_ind_y() {
    const offset = this.fetchByte();
    const ptrAddr = (this.SP + offset) & 0xFFFF;
    const lo = this.read(ptrAddr);
    const hi = this.read((ptrAddr + 1) & 0xFFFF);
    const addr = (hi << 8) | lo;
    return (this.DB << 16) | ((addr + this.Y) & 0xFFFF);
  }

    // --- Execution ---
  execute(opcode, pc, pb) {
    // Helper to log unimplemented opcodes one time
    const unimplemented = () => {
        console.log(`Unimplemented Opcode 0x${opcode.toString(16).toUpperCase().padStart(2, '0')} at ${pb.toString(16)}:${pc.toString(16)}`);
        this.stopped = true; // Stop here to prevent runaways when hitting gaps
    }

    // Branch cycle behavior (base +1 from step):
    // not taken = +1, taken = +2, emulation page-cross taken = +3.
    const branch8 = (condition) => {
      let offset = this.fetchByte();
      if (offset > 127) offset -= 256;

      this.cycles += 1; // Branch instruction base cycle adjustment

      if (condition) {
        const nextPC = this.PC;
        const target = (nextPC + offset) & 0xFFFF;
        this.PC = target;
        this.cycles += 1; // Taken branch cost

        if (this.P.E && ((nextPC ^ target) & 0xFF00)) {
          this.cycles += 1; // Emulation mode page-cross penalty
        }
      }
    };

    switch (opcode) {
      case 0x00: // BRK
        {
          const sig = this.fetchByte(); // Signature byte
          console.warn(`BRK triggered at ${this.PB.toString(16)}:${(this.PC-2).toString(16)}. Sig: ${sig.toString(16)}. E=${this.P.E}`);

          if (!this.P.E) { // Native
             this.push(this.PB);
             this.pushWord(this.PC);
             this.push(this.getP());
             this.P.D = 0;
             this.P.I = 1;
             this.PB = 0;
             const lo = this.read(0xFFE6);
             const hi = this.read(0xFFE7);
             const vector = (hi << 8) | lo;
             console.warn(`Native BRK Vector Read: ${lo.toString(16)} ${hi.toString(16)} -> ${vector.toString(16)}`);
             if (vector === 0) {
                 this.stopped = true;
                 console.error("BRK Vector Invalid (0000) - Stopping CPU");
                 this.dumpTrace();
                 throw new Error("Invalid BRK Vector");
             }
             if (vector === 0xFFFF) {
                 console.warn("BRK Vector is FFFF. This is usually empty. Ignoring/Continuing...");
                 // Technically we should jump to FFFF.
                 // If we strictly follow hardware, we jump to FFFF.
                 // let's jump.
             }
             this.PC = vector;
          } else { // Emu
             this.pushWord(this.PC);
             let p = 0;
             p |= this.P.N ? 0x80 : 0;
             p |= this.P.V ? 0x40 : 0;
             p |= 0x20;
             p |= 0x10; // B flag set for BRK
             p |= this.P.D ? 0x08 : 0;
             p |= this.P.I ? 0x04 : 0;
             p |= this.P.Z ? 0x02 : 0;
             p |= this.P.C ? 0x01 : 0;
             this.push(p);
             this.P.D = 0;
             this.P.I = 1;
             const lo = this.read(0xFFFE);
             const hi = this.read(0xFFFF);
             const vector = (hi << 8) | lo;
             console.warn(`Emu BRK Vector Read: ${lo.toString(16)} ${hi.toString(16)} -> ${vector.toString(16)}`);
             if (vector === 0) {
                 this.stopped = true; // Prevent infinite loop
                 console.error("BRK Vector Invalid (0000) - Stopping CPU");
                 this.dumpTrace();
                 throw new Error("Invalid BRK Vector (Emu)");
             }
             if (vector === 0xFFFF) {
                 console.warn("Emu BRK Vector is FFFF. Ignoring/Continuing...");
             }
             this.PC = vector;
          }
           this.cycles += this.P.E ? 6 : 7;
        }
        break;

      case 0x02: // COP
        {
          this.fetchByte();
          if (!this.P.E) { // Native
             this.push(this.PB);
             this.pushWord(this.PC);
             this.push(this.getP());
             this.P.D = 0;
             this.P.I = 1;
             this.PB = 0;
             const lo = this.read(0xFFE4);
             const hi = this.read(0xFFE5);
             this.PC = (hi << 8) | lo;
          } else { // Emu
             this.pushWord(this.PC);
             let p = 0;
             p |= this.P.N ? 0x80 : 0;
             p |= this.P.V ? 0x40 : 0;
             p |= 0x20;
             p |= this.P.D ? 0x08 : 0;
             p |= this.P.I ? 0x04 : 0;
             p |= this.P.Z ? 0x02 : 0;
             p |= this.P.C ? 0x01 : 0;
             this.push(p);
             this.P.D = 0;
             this.P.I = 1;
             const lo = this.read(0xFFF4);
             const hi = this.read(0xFFF5);
             this.PC = (hi << 8) | lo;
          }
           this.cycles += this.P.E ? 6 : 7;
        }
        break;

      // --- Flags ---
      case 0x18: this.P.C = 0; this.cycles += 1; break; // CLC
      case 0x38: this.P.C = 1; this.cycles += 1; break; // SEC
      case 0x58: this.P.I = 0; this.cycles += 1; break; // CLI
      case 0x78: this.P.I = 1; this.cycles += 1; break; // SEI
      case 0xB8: this.P.V = 0; this.cycles += 1; break; // CLV
      case 0xD8: this.P.D = 0; this.cycles += 1; break; // CLD
      case 0xF8: this.P.D = 1; this.cycles += 1; break; // SED

      case 0xC2: // REP (Reset Status Bits)
        {
          const val = this.fetchByte();
          if (val & 0x80) this.P.N = 0;
          if (val & 0x40) this.P.V = 0;
          if (!this.P.E && (val & 0x20)) { this.P.M = 0; } // 16-bit Accumulator
          if (!this.P.E && (val & 0x10)) { this.P.X = 0; } // 16-bit Index
          if (val & 0x08) this.P.D = 0;
          if (val & 0x04) this.P.I = 0;
          if (val & 0x02) this.P.Z = 0;
          if (val & 0x01) this.P.C = 0;
          this.cycles += 2;
        }
        break;

      case 0xE2: // SEP (Set Status Bits)
        {
          const val = this.fetchByte();
          if (val & 0x80) this.P.N = 1;
          if (val & 0x40) this.P.V = 1;
          if (val & 0x20) { this.P.M = 1; } // 8-bit Accumulator (B register preserved)
          if (val & 0x10) { this.P.X = 1; this.X &= 0xFF; this.Y &= 0xFF; } // 8-bit Index
          if (val & 0x08) this.P.D = 1;
          if (val & 0x04) this.P.I = 1;
          if (val & 0x02) this.P.Z = 1;
          if (val & 0x01) this.P.C = 1;
          this.cycles += 2;
        }
        break;

      case 0xFB: // XCE (Exchange Carry and Emulation)
        {
          const temp = this.P.C;
          this.P.C = this.P.E;
          this.P.E = temp;
          if (this.P.E) {
             // Switch to emulation mode defaults
             this.P.M = 1; this.P.X = 1;
             this.SP = (this.SP & 0xFF) | 0x0100;
          }
           this.cycles += 1;
        }
        break;

      // --- Flows ---
      case 0xEA:
        this.cycles += 1;
        break; // NOP
      case 0x42: // WDM #imm
        this.fetchByte(); // Reserved instruction: consume signature byte
        this.cycles += 1;
        break;
      case 0xCB: // WAI
        this.waiting = true;
        this.cycles += 2;
        break;
      case 0xDB: // STP
        this.stopped = true;
        this.cycles += 2;
        break;

      case 0x4C: // JMP abs
        {
          const addr = this.fetchWord();
          this.PC = addr;
          this.cycles += 2;
        }
        break;
      case 0x6C: // JMP (abs)
        {
          const ptr = this.fetchWord();
          const lo = this.read(ptr);
          const hi = this.read((ptr + 1) & 0xFFFF);
          this.PC = (hi << 8) | lo;
          this.cycles += 4;
        }
        break;
      case 0x7C: // JMP (abs,X)
        {
          const base = this.fetchWord();
          const ptr = (base + this.X) & 0xFFFF;
          const pbBase = this.PB << 16;
          const lo = this.read(pbBase | ptr);
          const hi = this.read(pbBase | ((ptr + 1) & 0xFFFF));
          this.PC = (hi << 8) | lo;
          this.cycles += 5;
        }
        break;
      case 0x5C: // JML long
        {
          const addr = this.fetchWord();
          const bank = this.fetchByte();
          this.PC = addr;
          this.PB = bank;
          this.cycles += 3;
        }
        break;

      case 0xDC: // JML [abs] (Indirect Long)
        {
          const ptr = this.fetchWord(); // 16-bit address in bank 0
          const lo = this.read(ptr);
          const hi = this.read((ptr + 1) & 0xFFFF);
          const bank = this.read((ptr + 2) & 0xFFFF);
          this.PC = (hi << 8) | lo;
          this.PB = bank;
          this.cycles += 5;
        }
        break;

      // BIT
      case 0x89: // BIT #imm — only Z is affected; N and V are NOT modified (unlike memory variants)
        {
          const val = this.P.M ? this.fetchByte() : this.fetchWord();
          this.P.Z = ((this.A & val) === 0) ? 1 : 0;
          this.cycles += 2 - (this.P.M ? 1 : 0);
        }
        break;
      case 0x24: // dp
      case 0x2C: // abs
        {
           const addr = (opcode === 0x24) ? this.addr_dp() : this.addr_abs();
           let val = 0;
           if (this.P.M) {
               val = this.read(addr);
               this.P.Z = ((this.A & val & 0xFF) === 0) ? 1 : 0;
               this.P.N = (val & 0x80) ? 1 : 0;
               this.P.V = (val & 0x40) ? 1 : 0;
           } else {
               val = this.readWord(addr);
               this.P.Z = ((this.A & val) === 0) ? 1 : 0;
               this.P.N = (val & 0x8000) ? 1 : 0;
               this.P.V = (val & 0x4000) ? 1 : 0;
           }
              this.cycles += (opcode === 0x24 ? 3 : 4) - (this.P.M ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0);
        }
        break;

      // JSR (Absolute, X)
      case 0xFC:
        {
          const base = this.fetchWord(); // PC += 2
          const ptr = (base + this.X) & 0xFFFF;
          const pbBase = this.PB << 16;
          const lo = this.read(pbBase | ptr);
          const hi = this.read(pbBase | ((ptr + 1) & 0xFFFF));
          this.pushWord(this.PC - 1);
          this.PC = (hi << 8) | lo;
          this.cycles += 7;
        }
        break;

      // JSR Absolute
      case 0x20:
        {
          const addr = this.fetchWord();
          this.pushWord(this.PC - 1); // JSR pushes PC+2-1?
          // Standard JSR pushes PC+2-1 (addr of last byte of instruction).
          // fetchWord incremented PC by 2. So PC is correct.
          // Address is fetched. New PC is addr.
          // We push (PC - 1).
          this.PC = addr;
          this.cycles += 5;
        }
        break;

      // Block Moves (MVP 0x44, MVN 0x54)
      case 0x44:
      case 0x54:
        {
            // Move exactly one byte per execution and re-execute until A underflows.
            // This matches 65816 MVN/MVP behavior where the instruction internally loops
            // by setting PC back to its own opcode while A != $FFFF.
            const destBank = this.fetchByte();
            const srcBank = this.fetchByte();

            const val = this.read((srcBank << 16) | this.X);
            this.write((destBank << 16) | this.Y, val);

            if (opcode === 0x54) { // MVN
              if (this.P.X) {
                this.X = (this.X + 1) & 0xFF; // 8-bit index: wrap at 0xFF
                this.Y = (this.Y + 1) & 0xFF;
              } else {
                this.X = (this.X + 1) & 0xFFFF;
                this.Y = (this.Y + 1) & 0xFFFF;
              }
            } else { // MVP
              if (this.P.X) {
                this.X = (this.X - 1) & 0xFF; // 8-bit index: wrap at 0x00
                this.Y = (this.Y - 1) & 0xFF;
              } else {
                this.X = (this.X - 1) & 0xFFFF;
                this.Y = (this.Y - 1) & 0xFFFF;
              }
            }

            this.A = (this.A - 1) & 0xFFFF;
            this.DB = destBank;

            // fetchByte/fetchByte advanced PC by 2 operands (+ opcode already fetched in step).
            // Rewind to opcode start to continue block move on next step.
            if (this.A !== 0xFFFF) {
              this.PC = (this.PC - 3) & 0xFFFF;
            }

            // step() adds the base 1 cycle; MVN/MVP total should be 7 cycles per moved byte.
            this.cycles += 6;
        }
        break;

      // JSL Long (0x22)
      case 0x22:
        {
            const addr = this.fetchWord();
            const bank = this.fetchByte();
            this.push(this.PB);
            this.pushWord(this.PC - 1); // Pushes address of last byte of instruction (Bank byte)
            // Wait, fetchByte() increments PC. PC is now Next Instruction.
            // Instruction was 4 bytes: Op, Lo, Hi, Bank.
            // PC points to next op.
            // Stack should have address of 'Bank' byte. So PC-1. Correct.
            this.PC = addr;
            this.PB = bank;
            this.cycles += 7;
        }
        break;

      // RTS (0x60)
      case 0x60:
        {
            this.PC = this.popWord();
            this.PC = (this.PC + 1) & 0xFFFF;
            this.cycles += 5;
        }
        break;

      // RTL (0x6B)
      case 0x6B:
        {
            this.PC = this.popWord();
            this.PB = this.pop();
            this.PC = (this.PC + 1) & 0xFFFF;
            this.cycles += 5;
        }
        break;

      // RTI (0x40)
      case 0x40:
        {
            const p = this.pop();
            this.P_set(p);
            this.PC = this.popWord();
            if (!this.P.E) {
                this.PB = this.pop();
            }
          this.cycles += this.P.E ? 5 : 6;
        }
        break;


      // --- Transfers ---
      case 0xAA: // TAX
        // Transfer width is determined by X flag only (not M flag): WDC 65816 datasheet
        if (this.P.X) {
            this.X = (this.X & 0xFF00) | (this.A & 0xFF);
            this.setZN(this.X & 0xFF, false);
        } else {
            // X=0: 16-bit index register — transfer full 16-bit C regardless of M
            this.X = this.A;
            this.setZN(this.X, true);
        }
        this.cycles += 1;
        break;
      case 0xA8: // TAY
        // Transfer width is determined by X flag only (not M flag): WDC 65816 datasheet
        if (this.P.X) { this.Y = (this.Y & 0xFF00) | (this.A & 0xFF); this.setZN(this.Y & 0xFF, false); }
        else { this.Y = this.A; this.setZN(this.Y, true); }
        this.cycles += 1;
        break;
      case 0x8A: // TXA
        if (this.P.M) { this.A = (this.A & 0xFF00) | (this.X & 0xFF); this.setZN(this.A & 0xFF, false); }
        else { this.A = this.P.X ? (this.X & 0xFF) : this.X; this.setZN(this.A, true); }
        this.cycles += 1;
        break;
      case 0x98: // TYA
        if (this.P.M) { this.A = (this.A & 0xFF00) | (this.Y & 0xFF); this.setZN(this.A & 0xFF, false); }
        else { this.A = this.P.X ? (this.Y & 0xFF) : this.Y; this.setZN(this.A, true); }
        this.cycles += 1;
        break;
      case 0x9A: // TXS
        this.SP = this.X;
        if (this.P.E) this.SP = 0x0100 | (this.SP & 0xFF);
        this.cycles += 1;
        break;
      case 0xBA: // TSX
        if (this.P.X) { this.X = (this.X & 0xFF00) | (this.SP & 0xFF); this.setZN(this.X & 0xFF, false); }
        else { this.X = this.SP; this.setZN(this.X, true); }
        this.cycles += 1;
        break;
      case 0x9B: // TXY
        if (this.P.X) { this.Y = (this.Y & 0xFF00) | (this.X & 0xFF); this.setZN(this.Y & 0xFF, false); }
        else { this.Y = this.X; this.setZN(this.Y, true); }
        this.cycles += 1;
        break;
      case 0xBB: // TYX
        if (this.P.X) { this.X = (this.X & 0xFF00) | (this.Y & 0xFF); this.setZN(this.X & 0xFF, false); }
        else { this.X = this.Y; this.setZN(this.X, true); }
        this.cycles += 1;
        break;

      // 16-bit Register Transfers
      case 0x5B: // TCD (Transfer A to Direct Page)
        this.DP = this.A; // Always uses full 16-bit A
        this.setZN(this.DP, true);
        this.cycles += 1;
        break;
      case 0x7B: // TDC (Transfer Direct Page to A)
        this.A = this.DP;
        this.setZN(this.A, true);
        this.cycles += 1;
        break;
      case 0x1B: // TCS (Transfer A to Stack Pointer)
        this.SP = this.A;
        if (this.P.E) this.SP = 0x0100 | (this.SP & 0xFF);
        // No flags affected
        this.cycles += 1;
        break;
      case 0x3B: // TSC (Transfer Stack Pointer to A)
        this.A = this.SP;
        this.setZN(this.A, true);
        this.cycles += 1;
        break;

      // Bank / Register Pushes & Pops
      case 0x4B: // PHK (Push Program Bank)
        this.push(this.PB);
        this.cycles += 2;
        break;
      case 0x8B: // PHB (Push Data Bank)
        this.push(this.DB);
        this.cycles += 2;
        break;
      case 0xAB: // PLB (Pop Data Bank)
        this.DB = this.pop();
        this.setZN(this.DB, false); // "N and Z flags are set according to the value pulled"
        this.cycles += 3;
        break;
      case 0x0B: // PHD (Push Direct Page)
        this.pushWord(this.DP);
        this.cycles += 3;
        break;
      case 0x2B: // PLD (Pop Direct Page)
        this.DP = this.popWord();
        this.setZN(this.DP, true);
        this.cycles += 4;
        break;

      case 0xF4: // PEA (Push Effective Absolute) -- 3 bytes, pushes 16-bit immediate
        {
          const val = this.fetchWord();
          this.pushWord(val);
          this.cycles += 4;
        }
        break;
      case 0xD4: // PEI (Push Effective Indirect) -- 2 bytes, pushes 16-bit from [DP+d]
        {
          const dp = this.fetchByte();
          const addr = (this.DP + dp) & 0xFFFF;
          const lo = this.read(addr);
          const hi = this.read((addr + 1) & 0xFFFF);
          this.pushWord((hi << 8) | lo);
          this.cycles += 5;
        }
        break;
      case 0x62: // PER (Push Effective PC Relative) -- 3 bytes, pushes PC+offset
        {
          const raw = this.fetchWord();
          const offset = raw >= 0x8000 ? raw - 0x10000 : raw;
          const target = (this.PC + offset) & 0xFFFF;
          this.pushWord(target);
          this.cycles += 5;
        }
        break;

      case 0xEB: // XBA (Exchange B and A bytes of Accumulator)
        {
          const low = this.A & 0xFF;
          const high = (this.A >> 8) & 0xFF;
          this.A = (low << 8) | high;
          this.setZN(high, false); // "N and Z flags are set according to the new low byte"
          this.cycles += 2;
        }
        break;

      // --- Increments / Decrements ---
      case 0xE6: // INC dp
        { const addr = this.addr_dp(); let val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { val = (val + 1) & 0xFF; this.write(addr, val); this.setZN(val, false); } else { val = (val + 1) & 0xFFFF; this.writeWord(addr, val); this.setZN(val, true); } this.cycles += this.P.M ? 4 : 6; }
        break;
      case 0xF6: // INC dp,x
        { const addr = this.addr_dp_x(); let val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { val = (val + 1) & 0xFF; this.write(addr, val); this.setZN(val, false); } else { val = (val + 1) & 0xFFFF; this.writeWord(addr, val); this.setZN(val, true); } this.cycles += this.P.M ? 5 : 7; }
        break;
      case 0xEE: // INC abs
        { const addr = this.addr_abs(); let val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { val = (val + 1) & 0xFF; this.write(addr, val); this.setZN(val, false); } else { val = (val + 1) & 0xFFFF; this.writeWord(addr, val); this.setZN(val, true); } this.cycles += this.P.M ? 5 : 7; }
        break;
      case 0xFE: // INC abs,x
        { const addr = this.addr_abs_x(); let val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { val = (val + 1) & 0xFF; this.write(addr, val); this.setZN(val, false); } else { val = (val + 1) & 0xFFFF; this.writeWord(addr, val); this.setZN(val, true); } this.cycles += this.P.M ? 6 : 8; }
        break;

      case 0xC6: // DEC dp
        { const addr = this.addr_dp(); let val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { val = (val - 1) & 0xFF; this.write(addr, val); this.setZN(val, false); } else { val = (val - 1) & 0xFFFF; this.writeWord(addr, val); this.setZN(val, true); } this.cycles += this.P.M ? 4 : 6; }
        break;
      case 0xD6: // DEC dp,x
        { const addr = this.addr_dp_x(); let val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { val = (val - 1) & 0xFF; this.write(addr, val); this.setZN(val, false); } else { val = (val - 1) & 0xFFFF; this.writeWord(addr, val); this.setZN(val, true); } this.cycles += this.P.M ? 5 : 7; }
        break;
      case 0xCE: // DEC abs
        { const addr = this.addr_abs(); let val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { val = (val - 1) & 0xFF; this.write(addr, val); this.setZN(val, false); } else { val = (val - 1) & 0xFFFF; this.writeWord(addr, val); this.setZN(val, true); } this.cycles += this.P.M ? 5 : 7; }
        break;
      case 0xDE: // DEC abs,x
        { const addr = this.addr_abs_x(); let val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { val = (val - 1) & 0xFF; this.write(addr, val); this.setZN(val, false); } else { val = (val - 1) & 0xFFFF; this.writeWord(addr, val); this.setZN(val, true); } this.cycles += this.P.M ? 6 : 8; }
        break;

      case 0xE8: // INX
        if (this.P.X) { this.X = (this.X & 0xFF00) | ((this.X + 1) & 0xFF); this.setZN(this.X & 0xFF, false); }
        else { this.X = (this.X + 1) & 0xFFFF; this.setZN(this.X, true); }
        this.cycles += 1;
        break;
      case 0xC8: // INY
        if (this.P.X) { this.Y = (this.Y & 0xFF00) | ((this.Y + 1) & 0xFF); this.setZN(this.Y & 0xFF, false); }
        else { this.Y = (this.Y + 1) & 0xFFFF; this.setZN(this.Y, true); }
        this.cycles += 1;
        break;
      case 0xCA: // DEX
        if (this.P.X) { this.X = (this.X & 0xFF00) | ((this.X - 1) & 0xFF); this.setZN(this.X & 0xFF, false); }
        else { this.X = (this.X - 1) & 0xFFFF; this.setZN(this.X, true); }
        this.cycles += 1;
        break;
      case 0x88: // DEY
        if (this.P.X) { this.Y = (this.Y & 0xFF00) | ((this.Y - 1) & 0xFF); this.setZN(this.Y & 0xFF, false); }
        else { this.Y = (this.Y - 1) & 0xFFFF; this.setZN(this.Y, true); }
        this.cycles += 1;
        break;
      case 0x1A: // INC A (Accumulator)
        if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A + 1) & 0xFF); this.setZN(this.A & 0xFF, false); }
        else { this.A = (this.A + 1) & 0xFFFF; this.setZN(this.A, true); }
        this.cycles += 1;
        break;
      case 0x3A: // DEC A
        if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A - 1) & 0xFF); this.setZN(this.A & 0xFF, false); }
        else { this.A = (this.A - 1) & 0xFFFF; this.setZN(this.A, true); }
        this.cycles += 1;
        break;

      // --- Logic (ORA, AND, EOR) ---
      // ORA
      case 0x09: // imm
        { const val = this.P.M ? this.fetchByte() : this.fetchWord(); if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A & 0xFF) | val); this.setZN(this.A & 0xFF, false); } else { this.A |= val; this.setZN(this.A, true); } this.cycles += 2 - (this.P.M ? 1 : 0); }
        break;
      case 0x05: // ORA dp
        { const addr = this.addr_dp(); const val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A & 0xFF) | val); this.setZN(this.A & 0xFF, false); } else { this.A |= val; this.setZN(this.A, true); } this.cycles += 3 - (this.P.M ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0); }
        break;
      case 0x15: // ORA dp,x
        { const addr = this.addr_dp_x(); const val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A & 0xFF) | val); this.setZN(this.A & 0xFF, false); } else { this.A |= val; this.setZN(this.A, true); } this.cycles += 4 - (this.P.M ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0); }
        break;
      case 0x0D: // ORA abs
        { const addr = this.addr_abs(); const val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A & 0xFF) | val); this.setZN(this.A & 0xFF, false); } else { this.A |= val; this.setZN(this.A, true); } this.cycles += 4 - (this.P.M ? 1 : 0); }
        break;
      case 0x1D: // ORA abs,x
        { const info = this.addr_abs_x_info(); const addr = info.addr; const val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A & 0xFF) | val); this.setZN(this.A & 0xFF, false); } else { this.A |= val; this.setZN(this.A, true); } this.cycles += 5 - (this.P.M ? 1 : 0) - (this.P.X ? 1 : 0); if (this.P.X && info.pageCrossed) this.cycles += 1; }
        break;
      case 0x19: // ORA abs,y
        { const info = this.addr_abs_y_info(); const addr = info.addr; const val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A & 0xFF) | val); this.setZN(this.A & 0xFF, false); } else { this.A |= val; this.setZN(this.A, true); } this.cycles += 5 - (this.P.M ? 1 : 0) - (this.P.X ? 1 : 0); if (this.P.X && info.pageCrossed) this.cycles += 1; }
        break;
      case 0x01: // ORA (dp,x)
        { const addr = this.addr_dp_ind_x(); const val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A & 0xFF) | val); this.setZN(this.A & 0xFF, false); } else { this.A |= val; this.setZN(this.A, true); } this.cycles += 6 - (this.P.M ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0); }
        break;
      case 0x11: // ORA (dp),y
        { const info = this.addr_dp_ind_y_info(); const addr = info.addr; const val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A & 0xFF) | val); this.setZN(this.A & 0xFF, false); } else { this.A |= val; this.setZN(this.A, true); } this.cycles += 6 - (this.P.M ? 1 : 0) - (this.P.X ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0); if (this.P.X && info.pageCrossed) this.cycles += 1; }
        break;
      case 0x12: // ORA (dp)
        { const addr = this.addr_dp_ind(); const val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A & 0xFF) | val); this.setZN(this.A & 0xFF, false); } else { this.A |= val; this.setZN(this.A, true); } this.cycles += 5 - (this.P.M ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0); }
        break;
      case 0x07: // ORA [dp]
        { const addr = this.addr_dp_ind_long(); const val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A & 0xFF) | val); this.setZN(this.A & 0xFF, false); } else { this.A |= val; this.setZN(this.A, true); } this.cycles += 6 - (this.P.M ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0); }
        break;
      case 0x17: // ORA [dp],y
        { const addr = this.addr_dp_ind_long_y(); const val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A & 0xFF) | val); this.setZN(this.A & 0xFF, false); } else { this.A |= val; this.setZN(this.A, true); } this.cycles += 6 - (this.P.M ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0); }
        break;
      case 0x03: // ORA sr,s
        { const addr = this.addr_sr(); const val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A & 0xFF) | val); this.setZN(this.A & 0xFF, false); } else { this.A |= val; this.setZN(this.A, true); } this.cycles += 4 - (this.P.M ? 1 : 0); }
        break;
      case 0x13: // ORA (sr,s),y
        { const addr = this.addr_sr_ind_y(); const val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A & 0xFF) | val); this.setZN(this.A & 0xFF, false); } else { this.A |= val; this.setZN(this.A, true); } this.cycles += 7 - (this.P.M ? 1 : 0); }
        break;
      case 0x0F: // ORA abs long
        { const addr = this.addr_absl(); const val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A & 0xFF) | val); this.setZN(this.A & 0xFF, false); } else { this.A |= val; this.setZN(this.A, true); } this.cycles += 5 - (this.P.M ? 1 : 0); }
        break;
      case 0x1F: // ORA abs long,x
        { const addr = (this.addr_absl() + this.X) & 0xFFFFFF; const val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A & 0xFF) | val); this.setZN(this.A & 0xFF, false); } else { this.A |= val; this.setZN(this.A, true); } this.cycles += 5 - (this.P.M ? 1 : 0); }
        break;

      // AND
      case 0x29: // imm
        { const val = this.P.M ? this.fetchByte() : this.fetchWord(); if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A & 0xFF) & val); this.setZN(this.A & 0xFF, false); } else { this.A &= val; this.setZN(this.A, true); } this.cycles += 2 - (this.P.M ? 1 : 0); }
        break;
      case 0x25: // AND dp
        { const addr = this.addr_dp(); const val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A & 0xFF) & val); this.setZN(this.A & 0xFF, false); } else { this.A &= val; this.setZN(this.A, true); } this.cycles += 3 - (this.P.M ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0); }
        break;
      case 0x35: // AND dp,x
        { const addr = this.addr_dp_x(); const val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A & 0xFF) & val); this.setZN(this.A & 0xFF, false); } else { this.A &= val; this.setZN(this.A, true); } this.cycles += 4 - (this.P.M ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0); }
        break;
      case 0x2D: // AND abs
        { const addr = this.addr_abs(); const val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A & 0xFF) & val); this.setZN(this.A & 0xFF, false); } else { this.A &= val; this.setZN(this.A, true); } this.cycles += 4 - (this.P.M ? 1 : 0); }
        break;
      case 0x3D: // AND abs,x
        { const info = this.addr_abs_x_info(); const addr = info.addr; const val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A & 0xFF) & val); this.setZN(this.A & 0xFF, false); } else { this.A &= val; this.setZN(this.A, true); } this.cycles += 5 - (this.P.M ? 1 : 0) - (this.P.X ? 1 : 0); if (this.P.X && info.pageCrossed) this.cycles += 1; }
        break;
      case 0x39: // AND abs,y
        { const info = this.addr_abs_y_info(); const addr = info.addr; const val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A & 0xFF) & val); this.setZN(this.A & 0xFF, false); } else { this.A &= val; this.setZN(this.A, true); } this.cycles += 5 - (this.P.M ? 1 : 0) - (this.P.X ? 1 : 0); if (this.P.X && info.pageCrossed) this.cycles += 1; }
        break;
      case 0x21: // AND (dp,x)
        { const addr = this.addr_dp_ind_x(); const val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A & 0xFF) & val); this.setZN(this.A & 0xFF, false); } else { this.A &= val; this.setZN(this.A, true); } this.cycles += 6 - (this.P.M ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0); }
        break;
      case 0x31: // AND (dp),y
        { const info = this.addr_dp_ind_y_info(); const addr = info.addr; const val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A & 0xFF) & val); this.setZN(this.A & 0xFF, false); } else { this.A &= val; this.setZN(this.A, true); } this.cycles += 6 - (this.P.M ? 1 : 0) - (this.P.X ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0); if (this.P.X && info.pageCrossed) this.cycles += 1; }
        break;
      case 0x32: // AND (dp)
        { const addr = this.addr_dp_ind(); const val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A & 0xFF) & val); this.setZN(this.A & 0xFF, false); } else { this.A &= val; this.setZN(this.A, true); } this.cycles += 5 - (this.P.M ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0); }
        break;
      case 0x27: // AND [dp]
        { const addr = this.addr_dp_ind_long(); const val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A & 0xFF) & val); this.setZN(this.A & 0xFF, false); } else { this.A &= val; this.setZN(this.A, true); } this.cycles += 6 - (this.P.M ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0); }
        break;
      case 0x37: // AND [dp],y
        { const addr = this.addr_dp_ind_long_y(); const val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A & 0xFF) & val); this.setZN(this.A & 0xFF, false); } else { this.A &= val; this.setZN(this.A, true); } this.cycles += 6 - (this.P.M ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0); }
        break;
      case 0x23: // AND sr,s
        { const addr = this.addr_sr(); const val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A & 0xFF) & val); this.setZN(this.A & 0xFF, false); } else { this.A &= val; this.setZN(this.A, true); } this.cycles += 4 - (this.P.M ? 1 : 0); }
        break;
      case 0x33: // AND (sr,s),y
        { const addr = this.addr_sr_ind_y(); const val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A & 0xFF) & val); this.setZN(this.A & 0xFF, false); } else { this.A &= val; this.setZN(this.A, true); } this.cycles += 7 - (this.P.M ? 1 : 0); }
        break;
      case 0x2F: // AND abs long
        { const addr = this.addr_absl(); const val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A & 0xFF) & val); this.setZN(this.A & 0xFF, false); } else { this.A &= val; this.setZN(this.A, true); } this.cycles += 5 - (this.P.M ? 1 : 0); }
        break;
      case 0x3F: // AND abs long,x
        { const addr = (this.addr_absl() + this.X) & 0xFFFFFF; const val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A & 0xFF) & val); this.setZN(this.A & 0xFF, false); } else { this.A &= val; this.setZN(this.A, true); } this.cycles += 5 - (this.P.M ? 1 : 0); }
        break;

      // EOR
      case 0x49: // imm
        { const val = this.P.M ? this.fetchByte() : this.fetchWord(); if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A & 0xFF) ^ val); this.setZN(this.A & 0xFF, false); } else { this.A ^= val; this.setZN(this.A, true); } this.cycles += 2 - (this.P.M ? 1 : 0); }
        break;
      case 0x45: // EOR dp
        { const addr = this.addr_dp(); const val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A & 0xFF) ^ val); this.setZN(this.A & 0xFF, false); } else { this.A ^= val; this.setZN(this.A, true); } this.cycles += 3 - (this.P.M ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0); }
        break;
      case 0x55: // EOR dp,x
        { const addr = this.addr_dp_x(); const val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A & 0xFF) ^ val); this.setZN(this.A & 0xFF, false); } else { this.A ^= val; this.setZN(this.A, true); } this.cycles += 4 - (this.P.M ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0); }
        break;
      case 0x4D: // EOR abs
        { const addr = this.addr_abs(); const val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A & 0xFF) ^ val); this.setZN(this.A & 0xFF, false); } else { this.A ^= val; this.setZN(this.A, true); } this.cycles += 4 - (this.P.M ? 1 : 0); }
        break;
      case 0x5D: // EOR abs,x
        { const info = this.addr_abs_x_info(); const addr = info.addr; const val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A & 0xFF) ^ val); this.setZN(this.A & 0xFF, false); } else { this.A ^= val; this.setZN(this.A, true); } this.cycles += 5 - (this.P.M ? 1 : 0) - (this.P.X ? 1 : 0); if (this.P.X && info.pageCrossed) this.cycles += 1; }
        break;
      case 0x59: // EOR abs,y
        { const info = this.addr_abs_y_info(); const addr = info.addr; const val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A & 0xFF) ^ val); this.setZN(this.A & 0xFF, false); } else { this.A ^= val; this.setZN(this.A, true); } this.cycles += 5 - (this.P.M ? 1 : 0) - (this.P.X ? 1 : 0); if (this.P.X && info.pageCrossed) this.cycles += 1; }
        break;
      case 0x41: // EOR (dp,x)
        { const addr = this.addr_dp_ind_x(); const val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A & 0xFF) ^ val); this.setZN(this.A & 0xFF, false); } else { this.A ^= val; this.setZN(this.A, true); } this.cycles += 6 - (this.P.M ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0); }
        break;
      case 0x51: // EOR (dp),y
        { const info = this.addr_dp_ind_y_info(); const addr = info.addr; const val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A & 0xFF) ^ val); this.setZN(this.A & 0xFF, false); } else { this.A ^= val; this.setZN(this.A, true); } this.cycles += 6 - (this.P.M ? 1 : 0) - (this.P.X ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0); if (this.P.X && info.pageCrossed) this.cycles += 1; }
        break;
      case 0x52: // EOR (dp)
        { const addr = this.addr_dp_ind(); const val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A & 0xFF) ^ val); this.setZN(this.A & 0xFF, false); } else { this.A ^= val; this.setZN(this.A, true); } this.cycles += 5 - (this.P.M ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0); }
        break;
      case 0x47: // EOR [dp]
        { const addr = this.addr_dp_ind_long(); const val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A & 0xFF) ^ val); this.setZN(this.A & 0xFF, false); } else { this.A ^= val; this.setZN(this.A, true); } this.cycles += 6 - (this.P.M ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0); }
        break;
      case 0x57: // EOR [dp],y
        { const addr = this.addr_dp_ind_long_y(); const val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A & 0xFF) ^ val); this.setZN(this.A & 0xFF, false); } else { this.A ^= val; this.setZN(this.A, true); } this.cycles += 6 - (this.P.M ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0); }
        break;
      case 0x43: // EOR sr,s
        { const addr = this.addr_sr(); const val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A & 0xFF) ^ val); this.setZN(this.A & 0xFF, false); } else { this.A ^= val; this.setZN(this.A, true); } this.cycles += 4 - (this.P.M ? 1 : 0); }
        break;
      case 0x53: // EOR (sr,s),y
        { const addr = this.addr_sr_ind_y(); const val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A & 0xFF) ^ val); this.setZN(this.A & 0xFF, false); } else { this.A ^= val; this.setZN(this.A, true); } this.cycles += 7 - (this.P.M ? 1 : 0); }
        break;
      case 0x4F: // EOR abs long
        { const addr = this.addr_absl(); const val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A & 0xFF) ^ val); this.setZN(this.A & 0xFF, false); } else { this.A ^= val; this.setZN(this.A, true); } this.cycles += 5 - (this.P.M ? 1 : 0); }
        break;
      case 0x5F: // EOR abs long,x
        { const addr = (this.addr_absl() + this.X) & 0xFFFFFF; const val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.A = (this.A & 0xFF00) | ((this.A & 0xFF) ^ val); this.setZN(this.A & 0xFF, false); } else { this.A ^= val; this.setZN(this.A, true); } this.cycles += 5 - (this.P.M ? 1 : 0); }
        break;

      // --- Arithmetic (ADC, SBC, CMP) ---
      case 0x69: // ADC imm
        this.adc(this.P.M ? this.fetchByte() : this.fetchWord());
        this.cycles += 2 - (this.P.M ? 1 : 0);
        break;
      case 0x65: // ADC dp
        this.adc(this.P.M ? this.read(this.addr_dp()) : this.readWord(this.addr_dp()));
        this.cycles += 3 - (this.P.M ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0);
        break;
      case 0x75: // ADC dp,x
        this.adc(this.P.M ? this.read(this.addr_dp_x()) : this.readWord(this.addr_dp_x()));
        this.cycles += 4 - (this.P.M ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0);
        break;
      case 0x6D: // ADC abs
        this.adc(this.P.M ? this.read(this.addr_abs()) : this.readWord(this.addr_abs()));
        this.cycles += 4 - (this.P.M ? 1 : 0);
        break;
      case 0x7D: // ADC abs,x
        {
          const info = this.addr_abs_x_info();
          this.adc(this.P.M ? this.read(info.addr) : this.readWord(info.addr));
          this.cycles += 5 - (this.P.M ? 1 : 0) - (this.P.X ? 1 : 0);
          if (this.P.X && info.pageCrossed) this.cycles += 1;
        }
        break;
      case 0x79: // ADC abs,y
        {
          const info = this.addr_abs_y_info();
          this.adc(this.P.M ? this.read(info.addr) : this.readWord(info.addr));
          this.cycles += 5 - (this.P.M ? 1 : 0) - (this.P.X ? 1 : 0);
          if (this.P.X && info.pageCrossed) this.cycles += 1;
        }
        break;
      case 0x61: // ADC (dp,x)
        this.adc(this.P.M ? this.read(this.addr_dp_ind_x()) : this.readWord(this.addr_dp_ind_x()));
        this.cycles += 6 - (this.P.M ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0);
        break;
      case 0x71: // ADC (dp),y
        {
          const info = this.addr_dp_ind_y_info();
          this.adc(this.P.M ? this.read(info.addr) : this.readWord(info.addr));
          this.cycles += 6 - (this.P.M ? 1 : 0) - (this.P.X ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0);
          if (this.P.X && info.pageCrossed) this.cycles += 1;
        }
        break;
      case 0x72: // ADC (dp)
        this.adc(this.P.M ? this.read(this.addr_dp_ind()) : this.readWord(this.addr_dp_ind()));
        this.cycles += 5 - (this.P.M ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0);
        break;
      case 0x67: // ADC [dp]
        this.adc(this.P.M ? this.read(this.addr_dp_ind_long()) : this.readWord(this.addr_dp_ind_long()));
        this.cycles += 6 - (this.P.M ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0);
        break;
      case 0x77: // ADC [dp],y
        this.adc(this.P.M ? this.read(this.addr_dp_ind_long_y()) : this.readWord(this.addr_dp_ind_long_y()));
        this.cycles += 6 - (this.P.M ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0);
        break;
      case 0x63: // ADC sr,s
        this.adc(this.P.M ? this.read(this.addr_sr()) : this.readWord(this.addr_sr()));
        this.cycles += 4 - (this.P.M ? 1 : 0);
        break;
      case 0x73: // ADC (sr,s),y
        this.adc(this.P.M ? this.read(this.addr_sr_ind_y()) : this.readWord(this.addr_sr_ind_y()));
        this.cycles += 7 - (this.P.M ? 1 : 0);
        break;
      case 0x6F: // ADC abs long
        this.adc(this.P.M ? this.read(this.addr_absl()) : this.readWord(this.addr_absl()));
        this.cycles += 5 - (this.P.M ? 1 : 0);
        break;
      case 0x7F: // ADC abs long,x
        this.adc(this.P.M ? this.read((this.addr_absl() + this.X) & 0xFFFFFF) : this.readWord((this.addr_absl() + this.X) & 0xFFFFFF));
        this.cycles += 5 - (this.P.M ? 1 : 0);
        break;

      case 0xE9: // SBC imm
        this.sbc(this.P.M ? this.fetchByte() : this.fetchWord());
        this.cycles += 2 - (this.P.M ? 1 : 0);
        break;
      case 0xE5: // SBC dp
        this.sbc(this.P.M ? this.read(this.addr_dp()) : this.readWord(this.addr_dp()));
        this.cycles += 3 - (this.P.M ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0);
        break;
      case 0xF5: // SBC dp,x
        this.sbc(this.P.M ? this.read(this.addr_dp_x()) : this.readWord(this.addr_dp_x()));
        this.cycles += 4 - (this.P.M ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0);
        break;
      case 0xED: // SBC abs
        this.sbc(this.P.M ? this.read(this.addr_abs()) : this.readWord(this.addr_abs()));
        this.cycles += 4 - (this.P.M ? 1 : 0);
        break;
      case 0xFD: // SBC abs,x
        {
          const info = this.addr_abs_x_info();
          this.sbc(this.P.M ? this.read(info.addr) : this.readWord(info.addr));
          this.cycles += 5 - (this.P.M ? 1 : 0) - (this.P.X ? 1 : 0);
          if (this.P.X && info.pageCrossed) this.cycles += 1;
        }
        break;
      case 0xF9: // SBC abs,y
        {
          const info = this.addr_abs_y_info();
          this.sbc(this.P.M ? this.read(info.addr) : this.readWord(info.addr));
          this.cycles += 5 - (this.P.M ? 1 : 0) - (this.P.X ? 1 : 0);
          if (this.P.X && info.pageCrossed) this.cycles += 1;
        }
        break;
      case 0xE1: // SBC (dp,x)
        this.sbc(this.P.M ? this.read(this.addr_dp_ind_x()) : this.readWord(this.addr_dp_ind_x()));
        this.cycles += 6 - (this.P.M ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0);
        break;
      case 0xF1: // SBC (dp),y
        {
          const info = this.addr_dp_ind_y_info();
          this.sbc(this.P.M ? this.read(info.addr) : this.readWord(info.addr));
          this.cycles += 6 - (this.P.M ? 1 : 0) - (this.P.X ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0);
          if (this.P.X && info.pageCrossed) this.cycles += 1;
        }
        break;
      case 0xF2: // SBC (dp)
        this.sbc(this.P.M ? this.read(this.addr_dp_ind()) : this.readWord(this.addr_dp_ind()));
        this.cycles += 5 - (this.P.M ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0);
        break;
      case 0xE7: // SBC [dp]
        this.sbc(this.P.M ? this.read(this.addr_dp_ind_long()) : this.readWord(this.addr_dp_ind_long()));
        this.cycles += 6 - (this.P.M ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0);
        break;
      case 0xF7: // SBC [dp],y
        this.sbc(this.P.M ? this.read(this.addr_dp_ind_long_y()) : this.readWord(this.addr_dp_ind_long_y()));
        this.cycles += 6 - (this.P.M ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0);
        break;
      case 0xE3: // SBC sr,s
        this.sbc(this.P.M ? this.read(this.addr_sr()) : this.readWord(this.addr_sr()));
        this.cycles += 4 - (this.P.M ? 1 : 0);
        break;
      case 0xF3: // SBC (sr,s),y
        this.sbc(this.P.M ? this.read(this.addr_sr_ind_y()) : this.readWord(this.addr_sr_ind_y()));
        this.cycles += 7 - (this.P.M ? 1 : 0);
        break;
      case 0xEF: // SBC abs long
        this.sbc(this.P.M ? this.read(this.addr_absl()) : this.readWord(this.addr_absl()));
        this.cycles += 5 - (this.P.M ? 1 : 0);
        break;
      case 0xFF: // SBC abs long,x
        this.sbc(this.P.M ? this.read((this.addr_absl() + this.X) & 0xFFFFFF) : this.readWord((this.addr_absl() + this.X) & 0xFFFFFF));
        this.cycles += 5 - (this.P.M ? 1 : 0);
        break;

      case 0xC9: // CMP imm
        this.cmp_reg(this.A, this.P.M ? this.fetchByte() : this.fetchWord(), !this.P.M);
        this.cycles += 2 - (this.P.M ? 1 : 0);
        break;
      case 0xCD: // CMP abs
        this.cmp_reg(this.A, this.P.M ? this.read(this.addr_abs()) : this.readWord(this.addr_abs()), !this.P.M);
        this.cycles += 4 - (this.P.M ? 1 : 0);
        break;
      case 0xC5: // CMP dp
        this.cmp_reg(this.A, this.P.M ? this.read(this.addr_dp()) : this.readWord(this.addr_dp()), !this.P.M);
        this.cycles += 3 - (this.P.M ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0);
        break;
      case 0xD5: // CMP dp,x
        this.cmp_reg(this.A, this.P.M ? this.read(this.addr_dp_x()) : this.readWord(this.addr_dp_x()), !this.P.M);
        this.cycles += 4 - (this.P.M ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0);
        break;
      case 0xDD: // CMP abs,x
        {
          const info = this.addr_abs_x_info();
          this.cmp_reg(this.A, this.P.M ? this.read(info.addr) : this.readWord(info.addr), !this.P.M);
          this.cycles += 5 - (this.P.M ? 1 : 0) - (this.P.X ? 1 : 0);
          if (this.P.X && info.pageCrossed) this.cycles += 1;
        }
        break;
      case 0xD9: // CMP abs,y
        {
          const info = this.addr_abs_y_info();
          this.cmp_reg(this.A, this.P.M ? this.read(info.addr) : this.readWord(info.addr), !this.P.M);
          this.cycles += 5 - (this.P.M ? 1 : 0) - (this.P.X ? 1 : 0);
          if (this.P.X && info.pageCrossed) this.cycles += 1;
        }
        break;
      case 0xC1: // CMP (dp,x)
        this.cmp_reg(this.A, this.P.M ? this.read(this.addr_dp_ind_x()) : this.readWord(this.addr_dp_ind_x()), !this.P.M);
        this.cycles += 6 - (this.P.M ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0);
        break;
      case 0xD1: // CMP (dp),y
        {
          const info = this.addr_dp_ind_y_info();
          this.cmp_reg(this.A, this.P.M ? this.read(info.addr) : this.readWord(info.addr), !this.P.M);
          this.cycles += 6 - (this.P.M ? 1 : 0) - (this.P.X ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0);
          if (this.P.X && info.pageCrossed) this.cycles += 1;
        }
        break;
      case 0xD2: // CMP (dp)
        this.cmp_reg(this.A, this.P.M ? this.read(this.addr_dp_ind()) : this.readWord(this.addr_dp_ind()), !this.P.M);
        this.cycles += 5 - (this.P.M ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0);
        break;
      case 0xC7: // CMP [dp]
        this.cmp_reg(this.A, this.P.M ? this.read(this.addr_dp_ind_long()) : this.readWord(this.addr_dp_ind_long()), !this.P.M);
        this.cycles += 6 - (this.P.M ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0);
        break;
      case 0xD7: // CMP [dp],y
        this.cmp_reg(this.A, this.P.M ? this.read(this.addr_dp_ind_long_y()) : this.readWord(this.addr_dp_ind_long_y()), !this.P.M);
        this.cycles += 6 - (this.P.M ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0);
        break;
      case 0xC3: // CMP sr,s
        this.cmp_reg(this.A, this.P.M ? this.read(this.addr_sr()) : this.readWord(this.addr_sr()), !this.P.M);
        this.cycles += 4 - (this.P.M ? 1 : 0);
        break;
      case 0xD3: // CMP (sr,s),y
        this.cmp_reg(this.A, this.P.M ? this.read(this.addr_sr_ind_y()) : this.readWord(this.addr_sr_ind_y()), !this.P.M);
        this.cycles += 7 - (this.P.M ? 1 : 0);
        break;
      case 0xCF: // CMP abs long
        this.cmp_reg(this.A, this.P.M ? this.read(this.addr_absl()) : this.readWord(this.addr_absl()), !this.P.M);
        this.cycles += 5 - (this.P.M ? 1 : 0);
        break;
      case 0xDF: // CMP abs long,x
        {
          const addr = (this.addr_absl() + this.X) & 0xFFFFFF;
          this.cmp_reg(this.A, this.P.M ? this.read(addr) : this.readWord(addr), !this.P.M);
          this.cycles += 5 - (this.P.M ? 1 : 0);
        }
        break;

      case 0xE0: // CPX imm
        this.cmp_reg(this.X, this.P.X ? this.fetchByte() : this.fetchWord(), !this.P.X);
        this.cycles += 2 - (this.P.X ? 1 : 0);
        break;
      case 0xE4: // CPX dp
        this.cmp_reg(this.X, this.P.X ? this.read(this.addr_dp()) : this.readWord(this.addr_dp()), !this.P.X);
        this.cycles += 3 - (this.P.X ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0);
        break;
      case 0xEC: // CPX abs
        this.cmp_reg(this.X, this.P.X ? this.read(this.addr_abs()) : this.readWord(this.addr_abs()), !this.P.X);
        this.cycles += 4 - (this.P.X ? 1 : 0);
        break;

      case 0xC0: // CPY imm
        this.cmp_reg(this.Y, this.P.X ? this.fetchByte() : this.fetchWord(), !this.P.X);
        this.cycles += 2 - (this.P.X ? 1 : 0);
        break;
      case 0xC4: // CPY dp
        this.cmp_reg(this.Y, this.P.X ? this.read(this.addr_dp()) : this.readWord(this.addr_dp()), !this.P.X);
        this.cycles += 3 - (this.P.X ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0);
        break;
      case 0xCC: // CPY abs
        this.cmp_reg(this.Y, this.P.X ? this.read(this.addr_abs()) : this.readWord(this.addr_abs()), !this.P.X);
        this.cycles += 4 - (this.P.X ? 1 : 0);
        break;

      // --- Bit Test (BIT indexed modes — not present in first switch block) ---
      case 0x34: // BIT dp,x
        {
          const val = this.P.M ? this.read(this.addr_dp_x()) : this.readWord(this.addr_dp_x());
          this.P.Z = ((this.A & val) === 0) ? 1 : 0;
          this.P.N = (val & (this.P.M ? 0x80 : 0x8000)) ? 1 : 0;
          this.P.V = (val & (this.P.M ? 0x40 : 0x4000)) ? 1 : 0;
          this.cycles += 4 - (this.P.M ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0);
        }
        break;
      case 0x3C: // BIT abs,x
        {
          const addr = this.addr_abs_x();
          const val = this.P.M ? this.read(addr) : this.readWord(addr);
          this.P.Z = ((this.A & val) === 0) ? 1 : 0;
          this.P.N = (val & (this.P.M ? 0x80 : 0x8000)) ? 1 : 0;
          this.P.V = (val & (this.P.M ? 0x40 : 0x4000)) ? 1 : 0;
          this.cycles += 4 - (this.P.M ? 1 : 0);
        }
        break;

       // TRB (Test and Reset Bits)
       case 0x14: // TRB dp
         { const addr=this.addr_dp(); let val=this.P.M?this.read(addr):this.readWord(addr); this.P.Z=((this.A & val)===0)?1:0; val &= ~this.A; if(this.P.M){this.write(addr, val & 0xFF);}else{this.writeWord(addr, val & 0xFFFF);} this.cycles += (this.P.M ? 4 : 5) + ((this.DP & 0xFF) ? 1 : 0); }
         break;
       case 0x1C: // TRB abs
         { const addr=this.addr_abs(); let val=this.P.M?this.read(addr):this.readWord(addr); this.P.Z=((this.A & val)===0)?1:0; val &= ~this.A; if(this.P.M){this.write(addr, val & 0xFF);}else{this.writeWord(addr, val & 0xFFFF);} this.cycles += this.P.M ? 5 : 6; }
         break;

       // TSB (Test and Set Bits)
       case 0x04: // TSB dp
         { const addr=this.addr_dp(); let val=this.P.M?this.read(addr):this.readWord(addr); this.P.Z=((this.A & val)===0)?1:0; val |= this.A; if(this.P.M){this.write(addr, val & 0xFF);}else{this.writeWord(addr, val & 0xFFFF);} this.cycles += (this.P.M ? 4 : 5) + ((this.DP & 0xFF) ? 1 : 0); }
         break;
       case 0x0C: // TSB abs
         { const addr=this.addr_abs(); let val=this.P.M?this.read(addr):this.readWord(addr); this.P.Z=((this.A & val)===0)?1:0; val |= this.A; if(this.P.M){this.write(addr, val & 0xFF);}else{this.writeWord(addr, val & 0xFFFF);} this.cycles += this.P.M ? 5 : 6; }
         break;

      // --- Shifts (Accumulator) ---
      case 0x0A: // ASL A
        if (this.P.M) { this.P.C = (this.A & 0x80) ? 1 : 0; this.A = (this.A & 0xFF00) | ((this.A << 1) & 0xFF); this.setZN(this.A & 0xFF, false); }
        else { this.P.C = (this.A & 0x8000) ? 1 : 0; this.A = (this.A << 1) & 0xFFFF; this.setZN(this.A, true); }
        this.cycles += 1;
        break;
      case 0x06: // ASL dp
        { const addr = this.addr_dp(); let val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.P.C = (val & 0x80) ? 1 : 0; val = (val << 1) & 0xFF; this.write(addr, val); this.setZN(val, false); } else { this.P.C = (val & 0x8000) ? 1 : 0; val = (val << 1) & 0xFFFF; this.writeWord(addr, val); this.setZN(val, true); } this.cycles += this.P.M ? 4 : 6; }
        break;
      case 0x16: // ASL dp,x
        { const addr = this.addr_dp_x(); let val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.P.C = (val & 0x80) ? 1 : 0; val = (val << 1) & 0xFF; this.write(addr, val); this.setZN(val, false); } else { this.P.C = (val & 0x8000) ? 1 : 0; val = (val << 1) & 0xFFFF; this.writeWord(addr, val); this.setZN(val, true); } this.cycles += this.P.M ? 5 : 7; }
        break;
      case 0x0E: // ASL abs
        { const addr = this.addr_abs(); let val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.P.C = (val & 0x80) ? 1 : 0; val = (val << 1) & 0xFF; this.write(addr, val); this.setZN(val, false); } else { this.P.C = (val & 0x8000) ? 1 : 0; val = (val << 1) & 0xFFFF; this.writeWord(addr, val); this.setZN(val, true); } this.cycles += this.P.M ? 5 : 7; }
        break;
      case 0x1E: // ASL abs,x
        { const addr = this.addr_abs_x(); let val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.P.C = (val & 0x80) ? 1 : 0; val = (val << 1) & 0xFF; this.write(addr, val); this.setZN(val, false); } else { this.P.C = (val & 0x8000) ? 1 : 0; val = (val << 1) & 0xFFFF; this.writeWord(addr, val); this.setZN(val, true); } this.cycles += this.P.M ? 6 : 8; }
        break;

      case 0x4A: // LSR A
        if (this.P.M) { this.P.C = (this.A & 0x01); this.A = (this.A & 0xFF00) | ((this.A >>> 1) & 0x7F); this.setZN(this.A & 0xFF, false); }
        else { this.P.C = (this.A & 0x01); this.A = (this.A >>> 1) & 0x7FFF; this.setZN(this.A, true); }
        this.cycles += 1;
        break;
      case 0x46: // LSR dp
        { const addr = this.addr_dp(); let val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.P.C = (val & 0x01); val = (val >>> 1) & 0x7F; this.write(addr, val); this.setZN(val, false); } else { this.P.C = (val & 0x01); val = (val >>> 1) & 0x7FFF; this.writeWord(addr, val); this.setZN(val, true); } this.cycles += this.P.M ? 4 : 6; }
        break;
      case 0x56: // LSR dp,x
        { const addr = this.addr_dp_x(); let val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.P.C = (val & 0x01); val = (val >>> 1) & 0x7F; this.write(addr, val); this.setZN(val, false); } else { this.P.C = (val & 0x01); val = (val >>> 1) & 0x7FFF; this.writeWord(addr, val); this.setZN(val, true); } this.cycles += this.P.M ? 5 : 7; }
        break;
      case 0x4E: // LSR abs
        { const addr = this.addr_abs(); let val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.P.C = (val & 0x01); val = (val >>> 1) & 0x7F; this.write(addr, val); this.setZN(val, false); } else { this.P.C = (val & 0x01); val = (val >>> 1) & 0x7FFF; this.writeWord(addr, val); this.setZN(val, true); } this.cycles += this.P.M ? 5 : 7; }
        break;
      case 0x5E: // LSR abs,x
        { const addr = this.addr_abs_x(); let val = this.P.M ? this.read(addr) : this.readWord(addr); if (this.P.M) { this.P.C = (val & 0x01); val = (val >>> 1) & 0x7F; this.write(addr, val); this.setZN(val, false); } else { this.P.C = (val & 0x01); val = (val >>> 1) & 0x7FFF; this.writeWord(addr, val); this.setZN(val, true); } this.cycles += this.P.M ? 6 : 8; }
        break;

      case 0x2A: // ROL A
        if (this.P.M) { const c = this.P.C; this.P.C = (this.A & 0x80) ? 1 : 0; this.A = (this.A & 0xFF00) | (((this.A << 1) & 0xFF) | c); this.setZN(this.A & 0xFF, false); }
        else { const c = this.P.C; this.P.C = (this.A & 0x8000) ? 1 : 0; this.A = (((this.A << 1) & 0xFFFF) | c); this.setZN(this.A, true); }
        this.cycles += 1;
        break;
      case 0x26: // ROL dp
        { const addr = this.addr_dp(); let val = this.P.M ? this.read(addr) : this.readWord(addr); const c = this.P.C; if (this.P.M) { this.P.C = (val & 0x80) ? 1 : 0; val = ((val << 1) & 0xFF) | c; this.write(addr, val); this.setZN(val, false); } else { this.P.C = (val & 0x8000) ? 1 : 0; val = ((val << 1) & 0xFFFF) | c; this.writeWord(addr, val); this.setZN(val, true); } this.cycles += this.P.M ? 4 : 6; }
        break;
      case 0x36: // ROL dp,x
        { const addr = this.addr_dp_x(); let val = this.P.M ? this.read(addr) : this.readWord(addr); const c = this.P.C; if (this.P.M) { this.P.C = (val & 0x80) ? 1 : 0; val = ((val << 1) & 0xFF) | c; this.write(addr, val); this.setZN(val, false); } else { this.P.C = (val & 0x8000) ? 1 : 0; val = ((val << 1) & 0xFFFF) | c; this.writeWord(addr, val); this.setZN(val, true); } this.cycles += this.P.M ? 5 : 7; }
        break;
      case 0x2E: // ROL abs
        { const addr = this.addr_abs(); let val = this.P.M ? this.read(addr) : this.readWord(addr); const c = this.P.C; if (this.P.M) { this.P.C = (val & 0x80) ? 1 : 0; val = ((val << 1) & 0xFF) | c; this.write(addr, val); this.setZN(val, false); } else { this.P.C = (val & 0x8000) ? 1 : 0; val = ((val << 1) & 0xFFFF) | c; this.writeWord(addr, val); this.setZN(val, true); } this.cycles += this.P.M ? 5 : 7; }
        break;
      case 0x3E: // ROL abs,x
        { const addr = this.addr_abs_x(); let val = this.P.M ? this.read(addr) : this.readWord(addr); const c = this.P.C; if (this.P.M) { this.P.C = (val & 0x80) ? 1 : 0; val = ((val << 1) & 0xFF) | c; this.write(addr, val); this.setZN(val, false); } else { this.P.C = (val & 0x8000) ? 1 : 0; val = ((val << 1) & 0xFFFF) | c; this.writeWord(addr, val); this.setZN(val, true); } this.cycles += this.P.M ? 6 : 8; }
        break;

      case 0x6A: // ROR A
        if (this.P.M) { const c = this.P.C; this.P.C = (this.A & 0x01); this.A = (this.A & 0xFF00) | (((this.A >>> 1) & 0x7F) | (c << 7)); this.setZN(this.A & 0xFF, false); }
        else { const c = this.P.C; this.P.C = (this.A & 0x01); this.A = (((this.A >>> 1) & 0x7FFF) | (c << 15)); this.setZN(this.A, true); }
        this.cycles += 1;
        break;
      case 0x66: // ROR dp
        { const addr = this.addr_dp(); let val = this.P.M ? this.read(addr) : this.readWord(addr); const c = this.P.C; if (this.P.M) { this.P.C = (val & 0x01); val = (((val >>> 1) & 0x7F) | (c << 7)); this.write(addr, val); this.setZN(val, false); } else { this.P.C = (val & 0x01); val = (((val >>> 1) & 0x7FFF) | (c << 15)); this.writeWord(addr, val); this.setZN(val, true); } this.cycles += this.P.M ? 4 : 6; }
        break;
      case 0x76: // ROR dp,x
        { const addr = this.addr_dp_x(); let val = this.P.M ? this.read(addr) : this.readWord(addr); const c = this.P.C; if (this.P.M) { this.P.C = (val & 0x01); val = (((val >>> 1) & 0x7F) | (c << 7)); this.write(addr, val); this.setZN(val, false); } else { this.P.C = (val & 0x01); val = (((val >>> 1) & 0x7FFF) | (c << 15)); this.writeWord(addr, val); this.setZN(val, true); } this.cycles += this.P.M ? 5 : 7; }
        break;
      case 0x6E: // ROR abs
        { const addr = this.addr_abs(); let val = this.P.M ? this.read(addr) : this.readWord(addr); const c = this.P.C; if (this.P.M) { this.P.C = (val & 0x01); val = (((val >>> 1) & 0x7F) | (c << 7)); this.write(addr, val); this.setZN(val, false); } else { this.P.C = (val & 0x01); val = (((val >>> 1) & 0x7FFF) | (c << 15)); this.writeWord(addr, val); this.setZN(val, true); } this.cycles += this.P.M ? 5 : 7; }
        break;
      case 0x7E: // ROR abs,x
        { const addr = this.addr_abs_x(); let val = this.P.M ? this.read(addr) : this.readWord(addr); const c = this.P.C; if (this.P.M) { this.P.C = (val & 0x01); val = (((val >>> 1) & 0x7F) | (c << 7)); this.write(addr, val); this.setZN(val, false); } else { this.P.C = (val & 0x01); val = (((val >>> 1) & 0x7FFF) | (c << 15)); this.writeWord(addr, val); this.setZN(val, true); } this.cycles += this.P.M ? 6 : 8; }
        break;

      // --- Loads ---
      // LDA
      case 0xA9: // LDA imm
        if (this.P.M) { this.A = (this.A & 0xFF00) | this.fetchByte(); this.setZN(this.A & 0xFF, false); }
        else { this.A = this.fetchWord(); this.setZN(this.A, true); }
        this.cycles += 2 - (this.P.M ? 1 : 0);
        break;
      case 0xA5: // LDA dp
        { const addr = this.addr_dp(); if (this.P.M) { this.A = (this.A & 0xFF00) | this.read(addr); this.setZN(this.A & 0xFF, false); } else { this.A = this.readWord(addr); this.setZN(this.A, true); } this.cycles += 3 - (this.P.M ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0); }
        break;
      case 0xB5: // LDA dp,x
        { const addr = this.addr_dp_x(); if (this.P.M) { this.A = (this.A & 0xFF00) | this.read(addr); this.setZN(this.A & 0xFF, false); } else { this.A = this.readWord(addr); this.setZN(this.A, true); } this.cycles += 4 - (this.P.M ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0); }
        break;
      case 0xAD: // LDA abs
        { const addr = this.addr_abs(); if (this.P.M) { this.A = (this.A & 0xFF00) | this.read(addr); this.setZN(this.A & 0xFF, false); } else { this.A = this.readWord(addr); this.setZN(this.A, true); } this.cycles += this.P.M ? 3 : 4; }
        break;
      case 0xBD: // LDA abs,x
        { const info = this.addr_abs_x_info(); const addr = info.addr; if (this.P.M) { this.A = (this.A & 0xFF00) | this.read(addr); this.setZN(this.A & 0xFF, false); } else { this.A = this.readWord(addr); this.setZN(this.A, true); } this.cycles += 5 - (this.P.M ? 1 : 0) - (this.P.X ? 1 : 0); if (this.P.X && info.pageCrossed) this.cycles += 1; }
        break;
      case 0xB9: // LDA abs,y
        { const info = this.addr_abs_y_info(); const addr = info.addr; if (this.P.M) { this.A = (this.A & 0xFF00) | this.read(addr); this.setZN(this.A & 0xFF, false); } else { this.A = this.readWord(addr); this.setZN(this.A, true); } this.cycles += 5 - (this.P.M ? 1 : 0) - (this.P.X ? 1 : 0); if (this.P.X && info.pageCrossed) this.cycles += 1; }
        break;
      case 0xA1: // LDA (dp,x)
        { const addr = this.addr_dp_ind_x(); if (this.P.M) { this.A = (this.A & 0xFF00) | this.read(addr); this.setZN(this.A & 0xFF, false); } else { this.A = this.readWord(addr); this.setZN(this.A, true); } this.cycles += 6 - (this.P.M ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0); }
        break;
      case 0xB1: // LDA (dp),y
        { const info = this.addr_dp_ind_y_info(); const addr = info.addr; if (this.P.M) { this.A = (this.A & 0xFF00) | this.read(addr); this.setZN(this.A & 0xFF, false); } else { this.A = this.readWord(addr); this.setZN(this.A, true); } this.cycles += 6 - (this.P.M ? 1 : 0) - (this.P.X ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0); if (this.P.X && info.pageCrossed) this.cycles += 1; }
        break;
      case 0xB2: // LDA (dp)
        { const addr = this.addr_dp_ind(); if (this.P.M) { this.A = (this.A & 0xFF00) | this.read(addr); this.setZN(this.A & 0xFF, false); } else { this.A = this.readWord(addr); this.setZN(this.A, true); } this.cycles += 5 - (this.P.M ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0); }
        break;
      case 0xA7: // LDA [dp]
        { const addr = this.addr_dp_ind_long(); if (this.P.M) { this.A = (this.A & 0xFF00) | this.read(addr); this.setZN(this.A & 0xFF, false); } else { this.A = this.readWord(addr); this.setZN(this.A, true); } this.cycles += 6 - (this.P.M ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0); }
        break;
      case 0xB7: // LDA [dp],y
        { const addr = this.addr_dp_ind_long_y(); if (this.P.M) { this.A = (this.A & 0xFF00) | this.read(addr); this.setZN(this.A & 0xFF, false); } else { this.A = this.readWord(addr); this.setZN(this.A, true); } this.cycles += 6 - (this.P.M ? 1 : 0) + ((this.DP & 0xFF) ? 1 : 0); }
        break;
      case 0xA3: // LDA sr,s
        { const addr = this.addr_sr(); if (this.P.M) { this.A = (this.A & 0xFF00) | this.read(addr); this.setZN(this.A & 0xFF, false); } else { this.A = this.readWord(addr); this.setZN(this.A, true); } this.cycles += 4 - (this.P.M ? 1 : 0); }
        break;
      case 0xB3: // LDA (sr,s),y
        { const addr = this.addr_sr_ind_y(); if (this.P.M) { this.A = (this.A & 0xFF00) | this.read(addr); this.setZN(this.A & 0xFF, false); } else { this.A = this.readWord(addr); this.setZN(this.A, true); } this.cycles += 7 - (this.P.M ? 1 : 0); }
        break;
      case 0xAF: // LDA abs long
        { const addr = this.addr_absl(); if (this.P.M) { this.A = (this.A & 0xFF00) | this.read(addr); this.setZN(this.A & 0xFF, false); } else { this.A = this.readWord(addr); this.setZN(this.A, true); } this.cycles += 5 - (this.P.M ? 1 : 0); }
        break;
      case 0xBF: // LDA abs long,x
        { const addr = (this.addr_absl() + this.X) & 0xFFFFFF; if (this.P.M) { this.A = (this.A & 0xFF00) | this.read(addr); this.setZN(this.A & 0xFF, false); } else { this.A = this.readWord(addr); this.setZN(this.A, true); } this.cycles += 5 - (this.P.M ? 1 : 0); }
        break;

      // LDX Immediate
      case 0xA2:
        {
          if (this.P.X) { // 8-bit
            this.X = (this.X & 0xFF00) | this.fetchByte();
            this.setZN(this.X & 0xFF, false);
          } else { // 16-bit
            this.X = this.fetchWord();
            this.setZN(this.X, true);
          }
          this.cycles += 2 - (this.P.X ? 1 : 0);
        }
        break;

      // LDY Immediate
      case 0xA0:
        {
          if (this.P.X) {
            this.Y = (this.Y & 0xFF00) | this.fetchByte();
            this.setZN(this.Y & 0xFF, false);
          } else {
            this.Y = this.fetchWord();
            this.setZN(this.Y, true);
          }
          this.cycles += 2 - (this.P.X ? 1 : 0);
        }
        break;

      // LDY (Load Index Y)
      case 0xA4: // LDY dp
      case 0xAC: // LDY abs
      case 0xB4: // LDY dp,x
      case 0xBC: // LDY abs,x
        {
          let addr;
          let crossed = false;
          if (opcode === 0xA4) addr = this.addr_dp();
          else if (opcode === 0xAC) addr = this.addr_abs();
          else if (opcode === 0xB4) addr = this.addr_dp_x();
          else {
            const info = this.addr_abs_x_info();
            addr = info.addr;
            crossed = info.pageCrossed;
          }

          if (this.P.X) {
             this.Y = (this.Y & 0xFF00) | this.read(addr);
             this.setZN(this.Y & 0xFF, false);
          } else {
             this.Y = this.readWord(addr);
             this.setZN(this.Y, true);
          }

          if (opcode === 0xAC) this.cycles += this.P.X ? 3 : 4;
          else if (opcode === 0xA4) this.cycles += (this.P.X ? 2 : 3) + ((this.DP & 0xFF) ? 1 : 0);
          else if (opcode === 0xB4) this.cycles += (this.P.X ? 3 : 4) + ((this.DP & 0xFF) ? 1 : 0);
          else if (opcode === 0xBC) {
            this.cycles += this.P.X ? 3 : 5;
            if (this.P.X && crossed) this.cycles += 1;
          }
        }
        break;

      // LDX (Load Index X)
      case 0xA6: // LDX dp
      case 0xAE: // LDX abs
      case 0xB6: // LDX dp,y
      case 0xBE: // LDX abs,y
        {
          let addr;
          let crossed = false;
          if (opcode === 0xA6) addr = this.addr_dp();
          else if (opcode === 0xAE) addr = this.addr_abs();
          else if (opcode === 0xB6) addr = this.addr_dp_y();
          else {
            const info = this.addr_abs_y_info();
            addr = info.addr;
            crossed = info.pageCrossed;
          }

          if (this.P.X) {
             this.X = (this.X & 0xFF00) | this.read(addr);
             this.setZN(this.X & 0xFF, false);
          } else {
             this.X = this.readWord(addr);
             this.setZN(this.X, true);
          }

          if (opcode === 0xAE) this.cycles += this.P.X ? 3 : 4;
          else if (opcode === 0xA6) this.cycles += (this.P.X ? 2 : 3) + ((this.DP & 0xFF) ? 1 : 0);
          else if (opcode === 0xB6) this.cycles += (this.P.X ? 3 : 4) + ((this.DP & 0xFF) ? 1 : 0);
          else if (opcode === 0xBE) {
            this.cycles += this.P.X ? 3 : 5;
            if (this.P.X && crossed) this.cycles += 1;
          }
        }
        break;

      // --- Stores ---
      // STA
      case 0x85: // STA dp
        if (this.P.M) this.write(this.addr_dp(), this.A & 0xFF); else { const addr=this.addr_dp(); this.write(addr, this.A & 0xFF); this.write(addr+1, (this.A>>8) & 0xFF); }
        this.cycles += (this.P.M ? 3 : 4) + ((this.DP & 0xFF) ? 1 : 0);
        break;
      case 0x95: // STA dp,x
        if (this.P.M) this.write(this.addr_dp_x(), this.A & 0xFF); else { const addr=this.addr_dp_x(); this.write(addr, this.A & 0xFF); this.write(addr+1, (this.A>>8) & 0xFF); }
        this.cycles += (this.P.M ? 4 : 5) + ((this.DP & 0xFF) ? 1 : 0);
        break;
      case 0x8D: // STA abs
        if (this.P.M) this.write(this.addr_abs(), this.A & 0xFF); else { const addr=this.addr_abs(); this.write(addr, this.A & 0xFF); this.write(addr+1, (this.A>>8) & 0xFF); } this.cycles += this.P.M ? 3 : 4;
        break;
      case 0x9D: // STA abs,x
        if (this.P.M) this.write(this.addr_abs_x(), this.A & 0xFF); else { const addr=this.addr_abs_x(); this.write(addr, this.A & 0xFF); this.write(addr+1, (this.A>>8) & 0xFF); } this.cycles += this.P.M ? 4 : 5;
        break;
      case 0x99: // STA abs,y
        if (this.P.M) this.write(this.addr_abs_y(), this.A & 0xFF); else { const addr=this.addr_abs_y(); this.write(addr, this.A & 0xFF); this.write(addr+1, (this.A>>8) & 0xFF); } this.cycles += this.P.M ? 4 : 5;
        break;
      case 0x81: // STA (dp,x)
        if (this.P.M) this.write(this.addr_dp_ind_x(), this.A & 0xFF); else { const addr=this.addr_dp_ind_x(); this.write(addr, this.A & 0xFF); this.write(addr+1, (this.A>>8) & 0xFF); }
        this.cycles += (this.P.M ? 6 : 7) + ((this.DP & 0xFF) ? 1 : 0);
        break;
      case 0x91: // STA (dp),y
        if (this.P.M) this.write(this.addr_dp_ind_y(), this.A & 0xFF); else { const addr=this.addr_dp_ind_y(); this.write(addr, this.A & 0xFF); this.write(addr+1, (this.A>>8) & 0xFF); }
        this.cycles += (this.P.M ? 6 : 7) + ((this.DP & 0xFF) ? 1 : 0);
        break;
      case 0x92: // STA (dp)
        if (this.P.M) this.write(this.addr_dp_ind(), this.A & 0xFF); else { const addr=this.addr_dp_ind(); this.write(addr, this.A & 0xFF); this.write(addr+1, (this.A>>8) & 0xFF); }
        this.cycles += (this.P.M ? 5 : 6) + ((this.DP & 0xFF) ? 1 : 0);
        break;
      case 0x87: // STA [dp]
        if (this.P.M) this.write(this.addr_dp_ind_long(), this.A & 0xFF); else { const addr=this.addr_dp_ind_long(); this.write(addr, this.A & 0xFF); this.write(addr+1, (this.A>>8) & 0xFF); }
        this.cycles += (this.P.M ? 6 : 7) + ((this.DP & 0xFF) ? 1 : 0);
        break;
      case 0x97: // STA [dp],y
        if (this.P.M) this.write(this.addr_dp_ind_long_y(), this.A & 0xFF); else { const addr=this.addr_dp_ind_long_y(); this.write(addr, this.A & 0xFF); this.write(addr+1, (this.A>>8) & 0xFF); }
        this.cycles += (this.P.M ? 6 : 7) + ((this.DP & 0xFF) ? 1 : 0);
        break;
      case 0x83: // STA sr,s
        if (this.P.M) this.write(this.addr_sr(), this.A & 0xFF); else { const addr=this.addr_sr(); this.write(addr, this.A & 0xFF); this.write(addr+1, (this.A>>8) & 0xFF); }
        this.cycles += this.P.M ? 4 : 5;
        break;
      case 0x93: // STA (sr,s),y
        if (this.P.M) this.write(this.addr_sr_ind_y(), this.A & 0xFF); else { const addr=this.addr_sr_ind_y(); this.write(addr, this.A & 0xFF); this.write(addr+1, (this.A>>8) & 0xFF); }
        this.cycles += this.P.M ? 7 : 8;
        break;
      case 0x8F: // STA abs long
        if (this.P.M) this.write(this.addr_absl(), this.A & 0xFF); else { const addr=this.addr_absl(); this.write(addr, this.A & 0xFF); this.write(addr+1, (this.A>>8) & 0xFF); }
        this.cycles += this.P.M ? 5 : 6;
        break;
      case 0x9F: // STA abs long,x
        { const addr = (this.addr_absl() + this.X) & 0xFFFFFF; if (this.P.M) this.write(addr, this.A & 0xFF); else { this.write(addr, this.A & 0xFF); this.write(addr+1, (this.A>>8) & 0xFF); } this.cycles += this.P.M ? 5 : 6; }
        break;

      // STX Direct Page
      case 0x86:
        if (this.P.X) this.write(this.addr_dp(), this.X & 0xFF); else { const addr=this.addr_dp(); this.write(addr, this.X & 0xFF); this.write(addr+1, (this.X>>8) & 0xFF); }
        this.cycles += (this.P.X ? 3 : 4) + ((this.DP & 0xFF) ? 1 : 0);
        break;
      case 0x96: // STX dp,y
        if (this.P.X) this.write(this.addr_dp_y(), this.X & 0xFF); else { const addr=this.addr_dp_y(); this.write(addr, this.X & 0xFF); this.write(addr+1, (this.X>>8) & 0xFF); }
        this.cycles += (this.P.X ? 4 : 5) + ((this.DP & 0xFF) ? 1 : 0);
        break;
      case 0x8E: // STX abs
        if (this.P.X) this.write(this.addr_abs(), this.X & 0xFF); else { const addr=this.addr_abs(); this.write(addr, this.X & 0xFF); this.write(addr+1, (this.X>>8) & 0xFF); }
        this.cycles += this.P.X ? 4 : 5;
        break;

      // STY Direct Page
      case 0x84:
        if (this.P.X) this.write(this.addr_dp(), this.Y & 0xFF); else { const addr=this.addr_dp(); this.write(addr, this.Y & 0xFF); this.write(addr+1, (this.Y>>8) & 0xFF); }
        this.cycles += (this.P.X ? 3 : 4) + ((this.DP & 0xFF) ? 1 : 0);
        break;
      case 0x94: // STY dp,x
        if (this.P.X) this.write(this.addr_dp_x(), this.Y & 0xFF); else { const addr=this.addr_dp_x(); this.write(addr, this.Y & 0xFF); this.write(addr+1, (this.Y>>8) & 0xFF); }
        this.cycles += (this.P.X ? 4 : 5) + ((this.DP & 0xFF) ? 1 : 0);
        break;
      case 0x8C: // STY abs
        if (this.P.X) this.write(this.addr_abs(), this.Y & 0xFF); else { const addr=this.addr_abs(); this.write(addr, this.Y & 0xFF); this.write(addr+1, (this.Y>>8) & 0xFF); }
        this.cycles += this.P.X ? 4 : 5;
        break;

      // STZ Direct Page
      case 0x64:
        if (this.P.M) this.write(this.addr_dp(), 0); else { const addr=this.addr_dp(); this.write(addr, 0); this.write(addr+1, 0); }
        this.cycles += (this.P.M ? 3 : 4) + ((this.DP & 0xFF) ? 1 : 0);
        break;
      case 0x74: // STZ dp,x
        if (this.P.M) this.write(this.addr_dp_x(), 0); else { const addr=this.addr_dp_x(); this.write(addr, 0); this.write(addr+1, 0); }
        this.cycles += (this.P.M ? 4 : 5) + ((this.DP & 0xFF) ? 1 : 0);
        break;

       // STZ Absolute (Store Zero)
       case 0x9C:
        if (this.P.M) this.write(this.addr_abs(), 0); else { const addr=this.addr_abs(); this.write(addr, 0); this.write(addr+1, 0); }
        this.cycles += this.P.M ? 4 : 5;
        break;
       case 0x9E: // STZ abs,x
        if (this.P.M) this.write(this.addr_abs_x(), 0); else { const addr=this.addr_abs_x(); this.write(addr, 0); this.write(addr+1, 0); }
        this.cycles += this.P.M ? 5 : 6;
        break;

      // --- Branches ---
      // BNE (Branch if Not Equal / Z=0)
      case 0xD0:
        branch8(this.P.Z === 0);
        break;

      // BEQ (Branch if Equal / Z=1)
      case 0xF0:
        branch8(this.P.Z === 1);
        break;

      // BPL (Branch if Plus / N=0)
      case 0x10:
        branch8(this.P.N === 0);
        break;

      // BMI (Branch if Minus / N=1)
      case 0x30:
        branch8(this.P.N === 1);
        break;

      // BVC (Branch if Overflow Clear / V=0)
      case 0x50:
        branch8(this.P.V === 0);
        break;

      // BVS (Branch if Overflow Set / V=1)
      case 0x70:
        branch8(this.P.V === 1);
        break;

      // BCC (Branch if Carry Clear / C=0)
      case 0x90:
        branch8(this.P.C === 0);
        break;

      // BCS (Branch if Carry Set / C=1)
      case 0xB0:
        branch8(this.P.C === 1);
        break;

      // BRA (Branch Always)
      case 0x80:
        {
           let offset = this.fetchByte();
           if (offset > 127) offset -= 256;
           const nextPC = this.PC;
           const target = (nextPC + offset) & 0xFFFF;
           this.PC = target;
           this.cycles += 2;
           if (this.P.E && ((nextPC ^ target) & 0xFF00)) {
             this.cycles += 1;
           }
        }
        break;

      // BRL (Branch Relative Long)
      case 0x82:
        {
           const offset = this.fetchWord();
           let off = offset;
           if (off > 32767) off -= 65536;
           this.PC = (this.PC + off) & 0xFFFF;
           this.cycles += 3;
        }
        break;

      // PHP (Push Processor Status)
      case 0x08:
        {
          let val = (this.P.N << 7) | (this.P.V << 6) | (this.P.D << 3) | (this.P.I << 2) | (this.P.Z << 1) | this.P.C;
          if (this.P.E) {
             val |= 0x30;
          } else {
             val |= (this.P.M << 5) | (this.P.X << 4);
          }
          this.push(val);
          this.cycles += 2;
        }
        break;

      // PLP (Pull Processor Status)
      case 0x28:
        {
          const val = this.pop();
          this.P.N = (val >> 7) & 1;
          this.P.V = (val >> 6) & 1;
          this.P.D = (val >> 3) & 1;
          this.P.I = (val >> 2) & 1;
          this.P.Z = (val >> 1) & 1;
          this.P.C = val & 1;

          if (!this.P.E) { // Native mode
             this.P.M = (val >> 5) & 1;
             this.P.X = (val >> 4) & 1;
             if (this.P.X) { this.X &= 0xFF; this.Y &= 0xFF; }
          }
           this.cycles += 3;
        }
        break;

      // --- Stack ---
      case 0x48: // PHA
        if (this.P.M) this.push(this.A & 0xFF);
        else this.pushWord(this.A);
        this.cycles += this.P.M ? 2 : 3;
        break;

      case 0x68: // PLA
        if (this.P.M) {
          this.A = (this.A & 0xFF00) | this.pop();
          this.setZN(this.A & 0xFF, false);
        } else {
          this.A = this.popWord();
          this.setZN(this.A, true);
        }
        this.cycles += this.P.M ? 3 : 4;
        break;

      case 0xDA: // PHX
        if (this.P.X) this.push(this.X & 0xFF);
        else this.pushWord(this.X);
        this.cycles += this.P.X ? 2 : 3;
        break;

      case 0xFA: // PLX
        if (this.P.X) {
            this.X = (this.X & 0xFF00) | this.pop();
            this.setZN(this.X & 0xFF, false);
        } else {
            this.X = this.popWord();
            this.setZN(this.X, true);
        }
        this.cycles += this.P.X ? 3 : 4;
        break;

      case 0x5A: // PHY
        if (this.P.X) this.push(this.Y & 0xFF);
        else this.pushWord(this.Y);
        this.cycles += this.P.X ? 2 : 3;
        break;

      case 0x7A: // PLY
        if (this.P.X) {
            this.Y = (this.Y & 0xFF00) | this.pop();
            this.setZN(this.Y & 0xFF, false);
        } else {
            this.Y = this.popWord();
            this.setZN(this.Y, true);
        }
        this.cycles += this.P.X ? 3 : 4;
        break;

      default:
        unimplemented();
        break;
    }
  }

  // --- Arithmetic Helpers ---
  adc(val) {
    if (this.P.M) { // 8-bit
        const a = this.A & 0xFF;
        const b = val & 0xFF; // operand
        const c = this.P.C;
        let sum = a + b + c;
        if (this.P.D) { // Decimal Mode (Simplified BCD)
            if ((a & 0xF) + (b & 0xF) + c > 9) sum += 6;
            if (sum > 0x9F) sum += 0x60;
        }

        this.P.V = (~(a ^ b) & (a ^ sum) & 0x80) ? 1 : 0;
        this.P.C = (sum > 0xFF) ? 1 : 0;
        const res = sum & 0xFF;
        this.A = (this.A & 0xFF00) | res;
        this.setZN(res, false);
    } else { // 16-bit
        const a = this.A;
        const b = val;
        const c = this.P.C;
      const sum = a + b + c;
      let res = sum & 0xFFFF;

      this.P.V = (~(a ^ b) & (a ^ sum) & 0x8000) ? 1 : 0;

      if (this.P.D) {
        let carry = c;
        let out = 0;
        for (let shift = 0; shift <= 12; shift += 4) {
          let nibble = ((a >> shift) & 0xF) + ((b >> shift) & 0xF) + carry;
          if (nibble > 9) nibble += 6;
          carry = nibble > 0xF ? 1 : 0;
          out |= (nibble & 0xF) << shift;
        }
        this.P.C = carry;
        res = out & 0xFFFF;
      } else {
        this.P.C = (sum > 0xFFFF) ? 1 : 0;
      }

        this.A = res;
        this.setZN(res, true);
    }
  }

  sbc(val) {
    if (this.P.M) { // 8-bit
        const a = this.A & 0xFF;
        const b = val & 0xFF;
        const c = this.P.C;
        // A - B - (1-C) = A + (~B) + C
        const sum = a + (~b & 0xFF) + c;

        // V flag is always computed from binary result (even in decimal mode)
        this.P.V = ((a ^ b) & (a ^ sum) & 0x80) ? 1 : 0;

        if (this.P.D) {
          // BCD decimal subtraction (8-bit)
          let borrow = c ? 0 : 1;
          let lo = (a & 0xF) - (b & 0xF) - borrow;
          if (lo < 0) { lo -= 6; borrow = 1; } else { borrow = 0; }
          let hi = ((a >> 4) & 0xF) - ((b >> 4) & 0xF) - borrow;
          if (hi < 0) { hi -= 6; borrow = 1; } else { borrow = 0; }
          this.P.C = borrow ? 0 : 1;
          const res = ((hi & 0xF) << 4) | (lo & 0xF);
          this.A = (this.A & 0xFF00) | (res & 0xFF);
          this.setZN(res, false);
        } else {
          this.P.C = (sum > 0xFF) ? 1 : 0;
          const res = sum & 0xFF;
          this.A = (this.A & 0xFF00) | res;
          this.setZN(res, false);
        }
    } else { // 16-bit
        const a = this.A;
        const b = val;
        const c = this.P.C;
      const sum = a + (~b & 0xFFFF) + c;
      let res = sum & 0xFFFF;

      this.P.V = ((a ^ b) & (a ^ sum) & 0x8000) ? 1 : 0;

      if (this.P.D) {
        let borrow = c ? 0 : 1;
        let out = 0;
        for (let shift = 0; shift <= 12; shift += 4) {
          let nibble = ((a >> shift) & 0xF) - ((b >> shift) & 0xF) - borrow;
          if (nibble < 0) {
            nibble -= 6;
            borrow = 1;
          } else {
            borrow = 0;
          }
          out |= (nibble & 0xF) << shift;
        }
        this.P.C = borrow ? 0 : 1;
        res = out & 0xFFFF;
      } else {
        this.P.C = (sum > 0xFFFF) ? 1 : 0;
      }

        this.A = res;
        this.setZN(res, true);
    }
  }

  cmp_reg(reg, val, is16bit) {
    if (!is16bit) {
        // 8-bit
        const r = reg & 0xFF;
        const v = val & 0xFF;
        const res = (r - v) & 0xFF;
        this.P.C = (r >= v) ? 1 : 0;
        this.setZN(res, false);
    } else {
        // 16-bit
        const r = reg & 0xFFFF;
        const v = val & 0xFFFF;
        const res = (r - v) & 0xFFFF;
        this.P.C = (r >= v) ? 1 : 0;
        this.setZN(res, true);
    }
  }

  P_set(val) {
    this.P.N = (val & 0x80) ? 1 : 0;
    this.P.V = (val & 0x40) ? 1 : 0;
    this.P.M = (val & 0x20) ? 1 : 0;
    this.P.X = (val & 0x10) ? 1 : 0;
    this.P.D = (val & 0x08) ? 1 : 0;
    this.P.I = (val & 0x04) ? 1 : 0;
    this.P.Z = (val & 0x02) ? 1 : 0;
    this.P.C = (val & 0x01) ? 1 : 0;

    // In emulation mode, M/X are forced to 1 and S high byte is fixed to $01.
    if (this.P.E) {
      this.P.M = 1;
      this.P.X = 1;
      this.SP = (this.SP & 0xFF) | 0x0100;
    }

    // When index registers are 8-bit, upper bytes must be cleared.
    if (this.P.X) {
      this.X &= 0x00FF;
      this.Y &= 0x00FF;
    }
  }

  getP() {
      let p = 0;
      p |= this.P.N ? 0x80 : 0;
      p |= this.P.V ? 0x40 : 0;
      p |= this.P.M ? 0x20 : 0;
      p |= this.P.X ? 0x10 : 0;
      p |= this.P.D ? 0x08 : 0;
      p |= this.P.I ? 0x04 : 0;
      p |= this.P.Z ? 0x02 : 0;
      p |= this.P.C ? 0x01 : 0;
      return p;
  }
}

exports.CPU = CPU;

};

registry['PPU'] = function(module,exports,require) {

class PPU {
  constructor() {
    this.vram = new Uint8Array(64 * 1024); // 64KB VRAM
    this.oam = new Uint8Array(544); // Object Attribute Memory
    this.cgram = new Uint8Array(512); // Color Generator RAM

    // Framebuffer (512x224, 32-bit RGBA) - Little Endian (ABGR)
    // Internal resolution is 512px wide so that mode 5/6 hi-res BG layers
    // (16 native source columns per 8px tilemap cell) can be represented at
    // full hardware resolution. Non-hires content is pixel-doubled to fill
    // the same 512px width.
    this.frameBuffer = new Uint32Array(512 * 224);

    // Line Buffers
    this.zBuffer = new Uint8Array(512);
    this.layerBuffer = new Uint8Array(512); // 0=Backdrop, 1=BG1, 2=BG2, 3=BG3, 4=BG4, 5=OBJ
    this.objBuffer = new Uint32Array(512); // Stores Sprite Color (0 = transparent), pixel-doubled
    this.objPrioBuffer = new Uint8Array(512); // Stores Sprite Priority (0-3), pixel-doubled
    this.objPalHighBuffer = new Uint8Array(512); // 1 = OBJ palette 4-7 (color-math eligible), 0 = palette 0-3

    // Registers
    this.inidisp = 0x8F; // Display Control 1 (Forced Blank on reset)
    this.obsel = 0;   // Object Size and Character Size
    this.oamaddl = 0; // OAM Address Low
    this.oamaddh = 0; // OAM Address High
    this.oamAddr = 0; // Internal OAM Byte Address (10-bit)
    this.bgmode = 0;  // BG Mode and Tile Size
    this.mosaic = 0;  // Mosaic

    // BG Screen Base and Sc Size ($2107-$210A)
    this.bg1sc = 0; this.bg2sc = 0; this.bg3sc = 0; this.bg4sc = 0;
    // BG Character Address ($210B-$210C)
    this.bg12nba = 0; this.bg34nba = 0;

    // Scroll Registers ($210D-$2114) - Write twice mechanism
    this.bg1hofs = 0; this.bg1vofs = 0;
    this.bg2hofs = 0; this.bg2vofs = 0;
    this.bg3hofs = 0; this.bg3vofs = 0;
    this.bg4hofs = 0; this.bg4vofs = 0;
    this.m7hofs = 0;  this.m7vofs = 0; // Mode 7

    // Internal latch for double-byte writes (Scroll, VRAM addr)
    this.bg_latch = 0;

    // Mode 7 Registers
    this.m7_latch = 0;
    this.m7a = 0; this.m7b = 0; this.m7c = 0; this.m7d = 0;
    this.m7x = 0; this.m7y = 0;
    this.m7sel = 0;

    // VRAM Address
    this.vmain = 0; // VRAM Address Increment Mode
    this.vmaddl = 0;
    this.vmaddh = 0;
    this.vramAddr = 0; // Internal full address
    this.vramReadBuffer = 0;

    // CGRAM Address
    this.cgadd = 0;
    this.cgdata_latch = null; // Write twice byte

    // OAM Latch
    this.oamWriteRegister = 0;
    this.oamFlip = 0;
    this.oamReadFlip = 0;

    // Window / Color Math (Simplified, placeholders)
    this.w12sel = 0; this.w34sel = 0; this.wobjsel = 0;
    this.wh0 = 0; this.wh1 = 0; this.wh2 = 0; this.wh3 = 0;
    this.wbglog = 0; this.wobjlog = 0;
    this.tm = 0; this.ts = 0; // Main/Sub screen designation
    this.cgwsel = 0;
    this.tmw = 0;
    this.tsw = 0; this.cgadsub = 0;
    this.coldataR = 0; this.coldataG = 0; this.coldataB = 0;

    // Status
    this.hvbjoy = 0; // V-Blank, H-Blank etc
    this.stat77 = 0; // PPU1 Status
    this.stat78 = 0; // PPU2 Status (Interlace)
    this.field = 0;  // 0 or 1
  }

  reset() {
      this.inidisp = 0x8F;
      this.vram.fill(0);
      this.oam.fill(0);
      this.cgram.fill(0);
      this.oamaddl = 0;
      this.oamaddh = 0;
      this.oamAddr = 0;
      this.oamWriteRegister = 0;
      this.oamFlip = 0;
      this.oamReadFlip = 0;
      this.stat77 = 0;
      this.stat78 = 0;
      this.field = 0;
  }

  multiplyResult() {
      const a = (this.m7a << 16) >> 16; // 16-bit signed
      const bSigned = ((this.m7b >> 8) << 24) >> 24; // upper 8-bits signed
      return a * bSigned;
  }

  read(addr) {
    // PPU Read ($2134-$213F mostly)
    switch(addr) {
        case 0x2134: return this.multiplyResult() & 0xFF; // MPY L
        case 0x2135: return (this.multiplyResult() >> 8) & 0xFF; // MPY M
        case 0x2136: return (this.multiplyResult() >> 16) & 0xFF; // MPY H
        case 0x2137: // SLHV (Software Latch)
            this.latchH = this.hcounter || 0;
            this.latchV = this.vcounter || 0;
            this.countersLatched = true;
            return 0; // return open bus or last read value
        case 0x2138:
            {
                let byte;
                if (this.oamAddr & 0x100) {
                    const addr = (((this.oamAddr & 0x10f) << 1) + (this.oamReadFlip & 1)) & 0x21f;
                    byte = this.oam[addr];
                    if (this.oamReadFlip & 1) {
                        this.oamAddr = (this.oamAddr + 1) & 0x1ff;
                    }
                } else {
                    const addr = ((this.oamAddr << 1) + (this.oamReadFlip & 1)) & 0x1ff;
                    byte = this.oam[addr];
                    if (this.oamReadFlip & 1) {
                        this.oamAddr = (this.oamAddr + 1) & 0x1ff;
                    }
                }
                this.oamReadFlip ^= 1;
                return byte;
            }
        case 0x2139: // VMDATALRead
           {
               const val = this.vramReadBuffer & 0xFF;
               if ((this.vmain & 0x80) === 0) {
                   this.incVramAddr();
                   this.updateVramRead();
               }
               return val;
           }
        case 0x213A: // VMDATAHRead
           {
               const val = (this.vramReadBuffer >> 8) & 0xFF;
               if ((this.vmain & 0x80) !== 0) {
                   this.incVramAddr();
                   this.updateVramRead();
               }
               return val;
           }
        case 0x213B: // CGDATA Read
           // Simplified: return 0 or implement palette read
           return 0;
        case 0x213C: { // OPHCT (Latched HCounter)
            if (this.ophctFlip) {
                this.ophctFlip = false;
                return ((this.latchH >> 8) & 0x01) | 0; // open bus bits 1-7
            } else {
                this.ophctFlip = true;
                return this.latchH & 0xFF;
            }
        }
        case 0x213D: { // OPVCT (Latched VCounter)
            if (this.opvctFlip) {
                this.opvctFlip = false;
                return ((this.latchV >> 8) & 0x01) | 0; // open bus bits 1-7
            } else {
                this.opvctFlip = true;
                return this.latchV & 0xFF;
            }
        }
        case 0x213E: return 1; // PPU1 Status (5=Over, 6=TimeOver, 7=AxB) - always 1 (v 0001) for revision
        case 0x213F:
           {
               // PPU2 Status
               // Bit 7: Field (0 or 1)
               // Bit 6: External Latch Flag
               // Bit 0-3: Version (usually 2 or 3)
               let latchFlag = this.countersLatched ? 0x40 : 0;
               const val = (this.field ? 0x80 : 0) | latchFlag | 0x03; // Revision 3

               // Reset latch word flip-flops
               this.ophctFlip = false;
               this.opvctFlip = false;
               this.countersLatched = false;
               return val;
           }
        default: return 0;
    }
  }

  write(addr, value) {
    switch (addr) {
        case 0x2100:
            this.inidisp = value;
            break;
        case 0x2101: this.obsel = value; break;
        case 0x2102:
            this.oamaddl = value;
            // Update internal OAM address (Word -> Byte)
            this.oamAddr = ((this.oamaddh & 1) << 8) | this.oamaddl;
            this.oamFlip = 0;
            this.oamReadFlip = 0;
            break;
        case 0x2103:
            this.oamaddh = value & 1;
            // Update internal OAM address (Word -> Byte)
            this.oamAddr = ((this.oamaddh & 1) << 8) | this.oamaddl;
            this.oamFlip = 0;
            this.oamReadFlip = 0;
            break;
        // OAMDATA ($2104)
        case 0x2104:
            if ((this.oamFlip & 1) === 0) {
                this.oamWriteRegister = (this.oamWriteRegister & 0xff00) | value;
            }

            if (this.oamAddr & 0x100) {
                const addr = (((this.oamAddr & 0x10f) << 1) + (this.oamFlip & 1)) & 0x21f;
                this.oam[addr] = value;
                if (this.oamFlip & 1) {
                    this.oamAddr = (this.oamAddr + 1) & 0x1ff;
                }
            } else if (this.oamFlip & 1) {
                const addr = (this.oamAddr << 1) & 0x1ff;
                this.oam[addr] = this.oamWriteRegister & 0xff;
                this.oam[addr + 1] = value;
                this.oamAddr = (this.oamAddr + 1) & 0x1ff;
            }

            this.oamFlip ^= 1;
            break;

        case 0x2105: this.bgmode = value; break;
        case 0x2106: this.mosaic = value; break;

        case 0x2107: this.bg1sc = value; break;
        case 0x2108: this.bg2sc = value; break;
        case 0x2109: this.bg3sc = value; break;
        case 0x210A: this.bg4sc = value; break;

        case 0x210B: this.bg12nba = value; break;
        case 0x210C: this.bg34nba = value; break;

        // Scroll (write twice)
        case 0x210D:
            // HOFS: (new<<8 | latch&~7 | old_hofs_hi&7)   (per bsnes)
            this.bg1hofs = ((value << 8) | (this.bg_latch & ~7) | ((this.bg1hofs >> 8) & 7)) ;
            this.m7hofs = (value << 8) | this.m7_latch;
            this.bg_latch = value; this.m7_latch = value;
            break;
        case 0x210E:
            // VOFS: (new<<8 | latch)   (per bsnes - simpler formula)
            this.bg1vofs = ((value << 8) | this.bg_latch) ;
            this.m7vofs = (value << 8) | this.m7_latch;
            this.bg_latch = value; this.m7_latch = value;
            break;
        case 0x210F: this.bg2hofs = ((value << 8) | (this.bg_latch & ~7) | ((this.bg2hofs >> 8) & 7)) ; this.bg_latch = value; break;
        case 0x2110: this.bg2vofs = ((value << 8) | this.bg_latch) ; this.bg_latch = value; break;
        case 0x2111: this.bg3hofs = ((value << 8) | (this.bg_latch & ~7) | ((this.bg3hofs >> 8) & 7)) ; this.bg_latch = value; break;
        case 0x2112: this.bg3vofs = ((value << 8) | this.bg_latch) ; this.bg_latch = value; break;
        case 0x2113: this.bg4hofs = ((value << 8) | (this.bg_latch & ~7) | ((this.bg4hofs >> 8) & 7)) ; this.bg_latch = value; break;
        case 0x2114: this.bg4vofs = ((value << 8) | this.bg_latch) ; this.bg_latch = value; break;

        case 0x2115: this.vmain = value; break;
        case 0x2116:
           this.vmaddl = value;
           this.vramAddr = (this.vmaddh << 8) | this.vmaddl;
           break;
        case 0x2117: this.vmaddh = value;
           this.vramAddr = (this.vmaddh << 8) | this.vmaddl;
           this.prefetchVram();
           break;

        case 0x2118: // VMDATAL
           {
               let addr = this.getVramTranslatedAddr();
               this.vram[addr * 2] = value;
               if ((this.vmain & 0x80) === 0) this.incVramAddr();
           }
           break;
        case 0x2119: // VMDATAH
           {
               let addr = this.getVramTranslatedAddr();
               this.vram[addr * 2 + 1] = value;
               if ((this.vmain & 0x80) !== 0) this.incVramAddr();
           }
           break;

        case 0x211A: this.m7sel = value; break;
        case 0x211B: this.m7a = (value << 8) | this.m7_latch; this.m7_latch = value; break;
        case 0x211C: this.m7b = (value << 8) | this.m7_latch; this.m7_latch = value; break;
        case 0x211D: this.m7c = (value << 8) | this.m7_latch; this.m7_latch = value; break;
        case 0x211E: this.m7d = (value << 8) | this.m7_latch; this.m7_latch = value; break;
        case 0x211F: this.m7x = (value << 8) | this.m7_latch; this.m7_latch = value; break;
        case 0x2120: this.m7y = (value << 8) | this.m7_latch; this.m7_latch = value; break;

        case 0x2121: this.cgadd = value; this.cgdata_latch = null; break;
        case 0x2122: // CGDATA - Write twice

           if (this.cgdata_latch === null) {
               this.cgdata_latch = value;
           } else {
               const addr = this.cgadd * 2;
               this.cgram[addr] = this.cgdata_latch;
               this.cgram[addr + 1] = value;

               this.cgadd = (this.cgadd + 1) & 0xFF;
               this.cgdata_latch = null;
           }
           break;

        case 0x212C: this.tm = value; break; // Main Screen Designation
        case 0x212D: this.ts = value; break; // Sub Screen Designation
        case 0x212E: this.tmw = value; break;
        case 0x212F: this.tsw = value; break;

        case 0x2123: this.wbg12 = value; break;
        case 0x2124: this.wbg34 = value; break;
        case 0x2125: this.wobjsel = value; break;
        case 0x2126: this.w1l = value; break;
        case 0x2127: this.w1r = value; break;
        case 0x2128: this.w2l = value; break;
        case 0x2129: this.w2r = value; break;
        case 0x212A: this.wbgobj = value; break;
        case 0x212B: this.wcolmath = value; break;

        case 0x2130: { this.cgwsel = value; break; }
        case 0x2131: { this.cgadsub = value; break; }
        case 0x2132:
           {
           if (value & 0x80) this.coldataB = value & 0x1F;
           if (value & 0x40) this.coldataG = value & 0x1F;
           if (value & 0x20) this.coldataR = value & 0x1F;
           break;
           }
        case 0x2133: this.setini = value; break;
    }
  }

  incVramAddr() {
      const step = [1, 32, 128, 128][this.vmain & 0x03];
      this.vramAddr = (this.vramAddr + step) & 0x7FFF;
  }

  getVramTranslatedAddr() {
      let addr = this.vramAddr & 0x7FFF;
      let mapping = (this.vmain >> 2) & 3;
      if (mapping === 0) return addr;
      if (mapping === 1) return (addr & 0xFF00) | ((addr & 0x00E0) >> 5) | ((addr & 0x001F) << 3);
      if (mapping === 2) return (addr & 0xFE00) | ((addr & 0x01C0) >> 6) | ((addr & 0x003F) << 3);
      if (mapping === 3) return (addr & 0xFC00) | ((addr & 0x0380) >> 7) | ((addr & 0x007F) << 3);
      return addr;
  }

  prefetchVram() {
      let addr = this.getVramTranslatedAddr();
      this.vramReadBuffer = (this.vram[addr * 2 + 1] << 8) | this.vram[addr * 2];
  }

  updateVramRead() {
      this.prefetchVram();
  }

  // --- Rendering ---

  getColor(paletteIndex) {
      const addr = (paletteIndex * 2) & 0x1FF;
      const lo = this.cgram[addr];
      const hi = this.cgram[addr + 1];
      const val = (hi << 8) | lo;

      const r5 = val & 0x1F;
      const g5 = (val >> 5) & 0x1F;
      const b5 = (val >> 10) & 0x1F;
      const r = (r5 << 3) | (r5 >> 2);
      const g = (g5 << 3) | (g5 >> 2);
      const b = (b5 << 3) | (b5 >> 2);

      // ABGR (A=mask)
      return (0xFF << 24) | (b << 16) | (g << 8) | r;
  }

  // Window range test for $2126-$2129 (W1L/W1R/W2L/W2R): inclusive range, empty when left>right.
  inWindowRange(x, left, right) {
      return x >= left && x <= right;
  }

  renderPass(line, layers, mode, bg3Prio, outputOffset) {
    if (mode === 0) {
        if (layers & 0x08) this.renderLayer(line, 4, 0, 10, 50);
        if (layers & 0x04) this.renderLayer(line, 3, 0, 20, 60);
        if (layers & 0x02) this.renderLayer(line, 2, 0, 30, 70);
        if (layers & 0x01) this.renderLayer(line, 1, 0, 40, 80);
    } else if (mode === 1) {
        // Mode 1 priority (front→back), per Snes9x's gfx.cpp (DO_BG/DrawOBJS depths,
        // including the shared "+D" screen-base offset which interleaves OBJ between
        // the BG high/low tiers): BG3-H_boost(110, only when BGMODE bit3 set) > OBJ-3(100) >
        // BG1-H(90) > BG2-H(80) > OBJ-2(70) > BG1-L(60) > BG2-L(50) > OBJ-1(40) >
        // BG3-H_noboost(30) > OBJ-0(20) > BG3-L(10).
        let zBg3L = 10, zBg3H = bg3Prio ? 110 : 30;
        let zBg1L = 60, zBg2L = 50, zBg1H = 90, zBg2H = 80;

        // Render from back to front, but zBuffer handles it anyway
        if (layers & 0x04) this.renderLayer(line, 3, 1, zBg3L, zBg3H); // BG3
        if (layers & 0x02) this.renderLayer(line, 2, 1, zBg2L, zBg2H); // BG2
        if (layers & 0x01) this.renderLayer(line, 1, 1, zBg1L, zBg1H); // BG1
    } else if (mode === 2) {
        // Mode 2: 16-color BGs, offset-per-tile
        if (layers & 0x02) this.renderLayer(line, 2, 2, 20, 50);
        if (layers & 0x01) this.renderLayer(line, 1, 2, 30, 60);
    } else if (mode >= 3 && mode <= 6) {
        // Other modes, primarily 3,4 (BG1=256-color)
        if (layers & 0x02) this.renderLayer(line, 2, mode, 20, 50);
        if (layers & 0x01) this.renderLayer(line, 1, mode, 30, 60);
    } else if (mode === 7) {
        if (layers & 0x01) this.renderMode7(line);
    }

    if (layers & 0x10) {
       const isSub = this.frameBuffer === this.subFrameBuffer;
       const tmw = isSub ? (this.tsw || 0) : (this.tmw || 0);
       const wobjsel = this.wobjsel || 0;
       const wbglog = this.wbgobj || 0;
       const wobjlog = this.wcolmath || 0; // WOBJLOG is 212B, bits 4-5
       const w1l = this.w1l || 0;
       const w1r = this.w1r || 0;
       const w2l = this.w2l || 0;
       const w2r = this.w2r || 0;

       let checkWindow = false;
       let w1E = false, w1I = false, w2E = false, w2I = false, logic = 0;
       if (tmw & 0x10) {
           checkWindow = true;
           w1E = (wobjsel & 0x02)!==0; w1I = (wobjsel & 0x01)!==0;
           w2E = (wobjsel & 0x08)!==0; w2I = (wobjsel & 0x04)!==0;
           logic = wobjlog & 0x03;
       }

       for (let x=0; x<512; x++) {
           if (checkWindow) {
              const x256 = x >> 1;
              let in1 = false, in2 = false;
              if (w1E) { let _w1in = this.inWindowRange(x256, w1l, w1r); in1 = w1I ? !_w1in : _w1in; }
              if (w2E) { let _w2in = this.inWindowRange(x256, w2l, w2r); in2 = w2I ? !_w2in : _w2in; }
              let masked = false;
              if (w1E && !w2E) masked = in1;
              else if (!w1E && w2E) masked = in2;
              else if (w1E && w2E) {
                  if (logic===0) masked = in1 || in2;
                  else if (logic===1) masked = in1 && in2;
                  else if (logic===2) masked = in1 !== in2;
                  else masked = in1 === in2;
              }
              if (masked) continue;
           }

           if (this.objBuffer[x] !== 0) {
               const p = this.objPrioBuffer[x];
               // Mode 1: OBJ-0(20) OBJ-1(40) OBJ-2(70) OBJ-3(100)
               // Other:  OBJ-0(20) OBJ-1(50) OBJ-2(80) OBJ-3(100)
               let z = (mode === 1) ? [20, 40, 70, 100][p] : [20, 50, 80, 100][p];
               if (z > this.zBuffer[x]) {
                   this.frameBuffer[outputOffset + x] = this.objBuffer[x];
                   this.zBuffer[x] = z;
                   this.layerBuffer[x] = 5;
               }
           }
       }
    }
  }

  renderLine(line) {
    if (line >= 224) return;

    this.zBuffer.fill(0); // Clear to 0 instead of 1
    this.layerBuffer.fill(0);
    this.objBuffer.fill(0);
    this.objPrioBuffer.fill(0);
    this.objPalHighBuffer.fill(0);

    const backdrop = this.getColor(0);
    const outputOffset = line * 512;

    // OP scene CGRAM[0] gradient scan: log a few scanlines during OP to see if HDMA updates it
    const fr = globalThis._snesFrame || 0;
    // OP scene diagnostics: log whenever tm/bgmode/inidisp changes
    if (globalThis._dmaLog && line === 0 && !(this.inidisp & 0x80) && fr > 10 && fr < 2000) {
        const tmKey = `${this.tm}_${this.bgmode}_${this.bg12nba}_${this.bg1sc}_${this.inidisp}_${this.bg34nba}_${this.bg3sc}`;
        if (this._lastTmKey !== tmKey) {
            this._lastTmKey = tmKey;
            const mode = this.bgmode & 0x07;
            const scBase1 = (this.bg1sc & 0xFC) << 9;
            const charBase1 = (this.bg12nba & 0x0F) << 13;
            let nonZeroChar = 0, nonZeroMap = 0, nonZeroCgram = 0;
            for (let i = 0; i < 256; i++) if (this.vram[(charBase1 + i) & 0xFFFF] !== 0) nonZeroChar++;
            for (let i = 0; i < 64; i++) if (this.vram[(scBase1 + i) & 0xFFFF] !== 0) nonZeroMap++;
            for (let i = 0; i < 512; i++) if (this.cgram[i] !== 0) nonZeroCgram++;
            const cg1 = (this.cgram[3] << 8) | this.cgram[2]; // CGRAM[1] = first non-backdrop color
            const cg16 = (this.cgram[33] << 8) | this.cgram[32]; // CGRAM[16]
            const bright = this.inidisp & 0x0F;
            const charBase3 = (this.bg34nba & 0x0F) << 13;
            const scBase3 = (this.bg3sc & 0xFC) << 9;
            // First entry of BG3 tilemap
            const map3_0 = (this.vram[(scBase3 + 1) & 0xFFFF] << 8) | this.vram[scBase3 & 0xFFFF];
            const map3_tileIdx = map3_0 & 0x3FF;
            const map3_pal = (map3_0 >> 10) & 7;
            // Tile 0 data (first 4 bytes of BG3 charBase)
            const chr3_0 = [this.vram[charBase3 & 0xFFFF], this.vram[(charBase3+1) & 0xFFFF], this.vram[(charBase3+2) & 0xFFFF], this.vram[(charBase3+3) & 0xFFFF]].map(b=>(b||0).toString(16).padStart(2,'0')).join(' ');
            // Tile N (first map entry) data - all 16 bytes
            const tileNByteAddr = (charBase3 + map3_tileIdx * 16) & 0xFFFF;
            const chr3_tileN = [];
            for (let _i = 0; _i < 16; _i++) chr3_tileN.push((this.vram[(tileNByteAddr+_i)&0xFFFF]||0).toString(16).padStart(2,'0'));
            // BG3 palette used by first tile (palIdx=map3_pal, 4 colors)
            const palBase = map3_pal * 4;
            const cg_sky = [];
            for (let _i = 0; _i < 4; _i++) cg_sky.push(((this.cgram[(palBase+_i)*2+1]<<8)|this.cgram[(palBase+_i)*2]).toString(16).padStart(4,'0'));
            // BG3 sub-palettes 0-7 (CGRAM[0..7])
            const cg_bg3 = [];
        }
    }

    if (this.inidisp & 0x80) {
        this.frameBuffer.fill(0xFF000000, outputOffset, outputOffset + 512);
        return;
    }

    const mode = this.bgmode & 0x07;
    const bg3Prio = (this.bgmode & 0x08) !== 0;

    // Always evaluate sprites once per line
    if ((this.tm | this.ts) & 0x10) {
        this.evaluateSprites(line);
    }

    // Sub Screen pass
    if (!this.subFrameBuffer) this.subFrameBuffer = new Uint32Array(512 * 224);
    if (!this.subLayerBuffer) this.subLayerBuffer = new Uint8Array(512);
    const origFrameBuffer = this.frameBuffer;
    this.frameBuffer = this.subFrameBuffer;
    this.zBuffer.fill(0);
    this.layerBuffer.fill(0);
    this.frameBuffer.fill(backdrop, outputOffset, outputOffset + 512);
    this.renderPass(line, this.ts, mode, bg3Prio, outputOffset);
    this.subLayerBuffer.set(this.layerBuffer);

    // Main Screen pass
    this.frameBuffer = origFrameBuffer;
    this.zBuffer.fill(0);
    this.layerBuffer.fill(0);
    this.frameBuffer.fill(backdrop, outputOffset, outputOffset + 512);
    this.renderPass(line, this.tm, mode, bg3Prio, outputOffset);

    if (this.cgadsub & 0x3F) {
        this.applyColorMath(line, outputOffset);
    }
    this.applyBrightness(line, outputOffset);
  }

  applyColorMath(line, outputOffset) {
      const isSub = !!(this.cgadsub & 0x80);
      let isHalf = (this.cgadsub & 0x40) !== 0;
      let enables = this.cgadsub & 0x3F;

      let rF = this.coldataR << 3;
      let gF = this.coldataG << 3;
      let bF = this.coldataB << 3;

      const cgwsel = this.cgwsel || 0;
      let mathEnable = (cgwsel & 0x30) >> 4; // Prevent: 0=Never, 1=Outside window, 2=Inside window, 3=Always
      const clipEnable = (cgwsel & 0xC0) >> 6; // Clip: 0=Never, 1=Outside window, 2=Inside window, 3=Always
      // CGWSEL Bit1: Sub Screen BG/OBJ Enable (0=Backdrop/COLDATA only, 1=Backdrop+BG+OBJ)
      // Bit0 is Direct Color mode for 256-color BGs, unrelated to color math source.
      let useSubscreen = (cgwsel & 0x02) !== 0;



      const wobjsel = this.wobjsel || 0;
      const w1Inv = (wobjsel & 0x10) !== 0;
      const w1En = (wobjsel & 0x20) !== 0;
      const w2Inv = (wobjsel & 0x40) !== 0;
      const w2En = (wobjsel & 0x80) !== 0;

      const maskLogic = this.wcolmath || 0;
      const mathLogic = (maskLogic & 0x0C) >> 2; // bits 3-2 = color math window logic per $212B

      const w1l = this.w1l || 0;
      const w1r = this.w1r || 0;
      const w2l = this.w2l || 0;
      const w2r = this.w2r || 0;

      for (let x = 0; x < 512; x++) {
          let mathPrevented = false;
          let clipBlack = false;

          const x256 = x >> 1;
          let windowValue = false;
          let inW1 = false;
          let inW2 = false;
          if (w1En || w2En) {
              if (w1En) {
                  const _inW1raw = this.inWindowRange(x256, w1l, w1r);
                  inW1 = w1Inv ? !_inW1raw : _inW1raw;
              }
              if (w2En) {
                  const _inW2raw = this.inWindowRange(x256, w2l, w2r);
                  inW2 = w2Inv ? !_inW2raw : _inW2raw;
              }
              if (mathLogic === 0) windowValue = inW1 || inW2;
              else if (mathLogic === 1) windowValue = inW1 && inW2;
              else if (mathLogic === 2) windowValue = (inW1 !== inW2);
              else windowValue = (inW1 === inW2);
          }

          if (mathEnable === 1 && !windowValue) mathPrevented = true;  // 01 = prevent OUTSIDE window
          if (mathEnable === 2 && windowValue) mathPrevented = true;   // 10 = prevent INSIDE window
          if (mathEnable === 3) mathPrevented = true;

          if (clipEnable === 1 && !windowValue) clipBlack = true;  // 01 = clip OUTSIDE window
          if (clipEnable === 2 && windowValue) clipBlack = true;   // 10 = clip INSIDE window
          if (clipEnable === 3) clipBlack = true;

          const layerId = this.layerBuffer[x];
          // CGADSUB bit layout (per fullsnes $2131): bit5=Backdrop, bit4=OBJ/Palette4-7, bit3=BG4, bit2=BG3, bit1=BG2, bit0=BG1
          // OBJ Palette 0-3 is always OFF (hardware spec); Palette 4-7 uses bit4.
          let layerBit = 0;
          if (layerId === 0) layerBit = 0x20;       // Backdrop (bit5)
          else if (layerId === 1) layerBit = 0x01;  // BG1 (bit0)
          else if (layerId === 2) layerBit = 0x02;  // BG2 (bit1)
          else if (layerId === 3) layerBit = 0x04;  // BG3 (bit2)
          else if (layerId === 4) layerBit = 0x08;  // BG4 (bit3)
          else if (layerId === 5) {
              // OBJ: palette 4-7 eligible (bit4); palette 0-3 always OFF
              layerBit = (this.objPalHighBuffer[x]) ? 0x10 : 0;
          }



          // When main-screen pixel is backdrop, subscreen (if enabled) shows through via color math.
          // The sub-screen contribution: non-transparent sub pixel → use sub color; transparent sub → use COLDATA.
          // This is handled naturally in the color math section below.
          // (No special addBackdrop case needed)

          if ((enables & layerBit) === 0) mathPrevented = true;

          let mainColor = this.frameBuffer[outputOffset + x];
          let r = clipBlack ? 0 : (mainColor & 0xFF);
          let g = clipBlack ? 0 : ((mainColor >> 8) & 0xFF);
          let b = clipBlack ? 0 : ((mainColor >> 16) & 0xFF);

          if (mathPrevented) {
              this.frameBuffer[outputOffset + x] = 0xFF000000 | (b << 16) | (g << 8) | r;
              continue;
          }

          let curRF, curGF, curBF;
          if (useSubscreen && this.subFrameBuffer) {
              // Use sub color only if sub pixel is non-transparent (subLayerBuffer[x] != 0)
              // Otherwise fall back to fixed color (COLDATA)
              if (this.subLayerBuffer && this.subLayerBuffer[x] !== 0) {
                  const subColor = this.subFrameBuffer[outputOffset + x];
                  curRF = subColor & 0xFF;
                  curGF = (subColor >> 8) & 0xFF;
                  curBF = (subColor >> 16) & 0xFF;
              } else {
                  curRF = rF;
                  curGF = gF;
                  curBF = bF;
              }
          } else {
              curRF = rF;
              curGF = gF;
              curBF = bF;
          }

          let resR, resG, resB;
          let r5 = Math.floor(r / 8);
          let g5 = Math.floor(g / 8);
          let b5 = Math.floor(b / 8);
          let cr5 = Math.floor(curRF / 8);
          let cg5 = Math.floor(curGF / 8);
          let cb5 = Math.floor(curBF / 8);

          if (isSub) {
              resR = Math.max(0, r5 - cr5);
              resG = Math.max(0, g5 - cg5);
              resB = Math.max(0, b5 - cb5);
          } else {
              resR = Math.min(31, r5 + cr5);
              resG = Math.min(31, g5 + cg5);
              resB = Math.min(31, b5 + cb5);
          }

          let applyHalf = isHalf;
          if (isHalf && useSubscreen && this.subLayerBuffer && this.subLayerBuffer[x] === 0) {
              applyHalf = false;
          }
          if (applyHalf) {
               resR >>= 1;
               resG >>= 1;
               resB >>= 1;
          }

          resR = (resR << 3) | (resR >> 2);
          resG = (resG << 3) | (resG >> 2);
          resB = (resB << 3) | (resB >> 2);



          this.frameBuffer[outputOffset + x] = 0xFF000000 | (resB << 16) | (resG << 8) | resR;
      }
  }

  applyBrightness(line, outputOffset) {
      const brightness = this.inidisp & 0x0F;
      if (brightness === 15) return;
      for (let x = 0; x < 512; x++) {
          const color = this.frameBuffer[outputOffset + x];
          let r = color & 0xFF;
          let g = (color >> 8) & 0xFF;
          let b = (color >> 16) & 0xFF;
          r = Math.floor((r * brightness) / 15);
          g = Math.floor((g * brightness) / 15);
          b = Math.floor((b * brightness) / 15);
          this.frameBuffer[outputOffset + x] = 0xFF000000 | (b << 16) | (g << 8) | r;
      }
  }

  renderLayer(line, bgIndex, mode, zLow, zHigh) {
      let scBase = 0;
      let charBase = 0;
      let bpp = 2;
      let paletteOffset = 0;
      let hScroll = 0;
      let vScroll = 0;
      let sc = 0;

      if (bgIndex === 1) {
          sc = this.bg1sc;
          scBase = (sc & 0xFC) << 9;
          charBase = (this.bg12nba & 0x0F) << 13;
          bpp = (mode === 0) ? 2 : ((mode === 3 || mode === 4) ? 8 : 4);
          paletteOffset = 0;
          hScroll = this.bg1hofs & 0x3FF;
          vScroll = this.bg1vofs & 0x3FF;
      } else if (bgIndex === 2) {
          sc = this.bg2sc;
          scBase = (sc & 0xFC) << 9;
          charBase = (this.bg12nba & 0xF0) << 9;
          bpp = (mode === 0 || mode === 4 || mode === 5) ? 2 : 4;
          paletteOffset = (mode === 0) ? 32 : 0;
          hScroll = this.bg2hofs & 0x3FF;
          vScroll = this.bg2vofs & 0x3FF;
      } else if (bgIndex === 3) {
          sc = this.bg3sc;
          scBase = (sc & 0xFC) << 9;
          charBase = (this.bg34nba & 0x0F) << 13;
          bpp = (mode === 0) ? 2 : ((mode === 1) ? 2 : 4);
          paletteOffset = (mode === 0) ? 64 : 0;
          hScroll = this.bg3hofs & 0x3FF;
          vScroll = this.bg3vofs & 0x3FF;
      } else if (bgIndex === 4) {
          sc = this.bg4sc;
          scBase = (sc & 0xFC) << 9;
          charBase = (this.bg34nba & 0xF0) << 9;
          bpp = 2;
          paletteOffset = 96;
          hScroll = this.bg4hofs & 0x3FF;
          vScroll = this.bg4vofs & 0x3FF;
      }

      const outputOffset = line * 512;
      const screenSize = sc & 3; // 0=32x32, 1=64x32, 2=32x64, 3=64x64

      const isSub = this.frameBuffer === this.subFrameBuffer;
      const tmw = isSub ? (this.tsw || 0) : (this.tmw || 0);
      const w12sel = this.wbg12 || 0;
      const w34sel = this.wbg34 || 0;
      const wbglog = this.wbgobj || 0;
      const w1l = this.w1l || 0;
      const w1r = this.w1r || 0;
      const w2l = this.w2l || 0;
      const w2r = this.w2r || 0;

      let checkWindow = false;
      let w1E = false, w1I = false, w2E = false, w2I = false, logic = 0;
      if (bgIndex === 1 && (tmw & 0x01)) {
          checkWindow = true; w1E = (w12sel & 0x02)!==0; w1I = (w12sel & 0x01)!==0;
          w2E = (w12sel & 0x08)!==0; w2I = (w12sel & 0x04)!==0; logic = wbglog & 0x03;
      } else if (bgIndex === 2 && (tmw & 0x02)) {
          checkWindow = true; w1E = (w12sel & 0x20)!==0; w1I = (w12sel & 0x10)!==0;
          w2E = (w12sel & 0x80)!==0; w2I = (w12sel & 0x40)!==0; logic = (wbglog & 0x0C)>>2;
      } else if (bgIndex === 3 && (tmw & 0x04)) {
          checkWindow = true; w1E = (w34sel & 0x02)!==0; w1I = (w34sel & 0x01)!==0;
          w2E = (w34sel & 0x08)!==0; w2I = (w34sel & 0x04)!==0; logic = (wbglog & 0x30)>>4;
      } else if (bgIndex === 4 && (tmw & 0x08)) {
          checkWindow = true; w1E = (w34sel & 0x20)!==0; w1I = (w34sel & 0x10)!==0;
          w2E = (w34sel & 0x80)!==0; w2I = (w34sel & 0x40)!==0; logic = (wbglog & 0xC0)>>6;
      }

      // Tile size: bgmode bits 4-7 control tile size per BG (0=8x8, 1=16x16)
      // bit4=BG1, bit5=BG2, bit6=BG3, bit7=BG4
      const large = !!((this.bgmode >> (3 + bgIndex)) & 1);
      const tileShift = large ? 4 : 3;   // 16px or 8px per tile
      const pageShift = large ? 9 : 8;   // 512px or 256px per tilemap page

      // Mode 5/6 hi-res BG layers: each 8x8 tilemap cell covers a 16x8 area,
      // formed from two adjacent character tiles (tileIdx, tileIdx+1), each
      // contributing its even-numbered columns.
      const hires = (mode === 5 && (bgIndex === 1 || bgIndex === 2)) || (mode === 6 && bgIndex === 1);

      // Mode 2/4/6 OPT: per-column H/V scroll overrides from BG3 tilemap.
      // H-entry: bit13=BG1 valid, bit14=BG2 valid. V-entry: same bit layout.
      // When valid bit set: use entry bits[0:8] as scroll. When clear: use layer's global scroll.
      let optH = null;
      let optV = null;
      if (mode === 2 || mode === 4 || mode === 6) {
          const g3sc = this.bg3sc;
          const g3Base = (g3sc & 0xFC) << 9;
          const g3SS = g3sc & 3;
          const g3MCols = (g3SS & 1) ? 64 : 32;
          const g3MRows = (g3SS & 2) ? 64 : 32;
          const g3Hofs = this.bg3hofs & 0x3FF;
          const g3Vofs = this.bg3vofs & 0x3FF;
          const optHRow = (g3Vofs >> 3) % g3MRows;
          const optVRow = (optHRow + 1) % g3MRows;

          const readG3 = (row, col) => {
              col = col % g3MCols;
              row = row % g3MRows;
              let mOff = 0;
              if (g3SS === 1) { mOff = col >= 32 ? 2048 : 0; col &= 31; }
              else if (g3SS === 2) { mOff = row >= 32 ? 2048 : 0; row &= 31; }
              else if (g3SS === 3) { mOff = ((row >= 32 ? 2 : 0) + (col >= 32 ? 1 : 0)) * 2048; row &= 31; col &= 31; }
              const a = g3Base + mOff + (row * 32 + col) * 2;
              return (this.vram[(a + 1) & 0xFFFF] << 8) | this.vram[a & 0xFFFF];
          };

          // bit13 (0x2000) validates BG1; bit14 (0x4000) validates BG2
          const validBit = bgIndex === 1 ? 0x2000 : 0x4000;
          optH = new Int32Array(32);
          optV = new Int32Array(32);
          for (let ci = 0; ci < 32; ci++) {
              const g3c = ((g3Hofs >> 3) + ci + 1) % g3MCols;
              const hEntry = readG3(optHRow, g3c);
              const vEntry = readG3(optVRow, g3c);
              optH[ci] = (hEntry & validBit) ? (hEntry & 0x1FF) : hScroll;
              optV[ci] = (vEntry & validBit) ? (vEntry & 0x1FF) : vScroll;
          }
      }

      for (let x256 = 0; x256 < 256; x256++) {
          if (checkWindow) {
              let in1 = false, in2 = false;
              if (w1E) { let _w1in = this.inWindowRange(x256, w1l, w1r); in1 = w1I ? !_w1in : _w1in; }
              if (w2E) { let _w2in = this.inWindowRange(x256, w2l, w2r); in2 = w2I ? !_w2in : _w2in; }
              let masked = false;
              if (w1E && !w2E) masked = in1;
              else if (!w1E && w2E) masked = in2;
              else if (w1E && w2E) {
                  if (logic===0) masked = in1 || in2;
                  else if (logic===1) masked = in1 && in2;
                  else if (logic===2) masked = in1 !== in2;
                  else masked = in1 === in2;
              }
              if (masked) continue;
          }

          const _col = x256 >> 3;
          const rX = x256 + (optH ? optH[_col] : hScroll);
          const rY = line + (optV ? optV[_col] : vScroll);

          // Determine which tilemap page (each page = 32×32 tile entries = 2KB)
          const mapX = (rX >> pageShift);
          const mapY = (rY >> pageShift);

          let mapOff = 0;
          if (screenSize === 0) {
              mapOff = 0;
          } else if (screenSize === 1) { // 64x32 (two horizontal pages)
              mapOff = (mapX & 1) * 2048;
          } else if (screenSize === 2) { // 32x64 (two vertical pages)
              mapOff = (mapY & 1) * 2048;
          } else { // 64x64 (four pages)
              mapOff = ((mapY & 1) * 2 + (mapX & 1)) * 2048;
          }

          // Tile map position (each entry covers tileSize×tileSize pixels)
          const tileX = (rX >> tileShift) & 0x1F;
          const tileY = (rY >> tileShift) & 0x1F;

          const mapAddr = scBase + mapOff + (tileY * 32 + tileX) * 2;

          const t1 = this.vram[mapAddr & 0xFFFF];
          const t2 = this.vram[(mapAddr + 1) & 0xFFFF];
          const entry = (t2 << 8) | t1;

          const tileIdxBase = entry & 0x03FF;
          const palIdx = (entry >> 10) & 0x07;
          const prio = (entry >> 13) & 1;
          const flipX = (entry >> 14) & 1;
          const flipY = (entry >> 15) & 1;

          // For 16x16 tiles, determine which 8x8 sub-tile we're rendering
          let tileIdx = tileIdxBase;
          if (large) {
              let subX = (rX >> 3) & 1;
              let subY = (rY >> 3) & 1;
              if (flipX) subX = 1 - subX;
              if (flipY) subY = 1 - subY;
              tileIdx = (tileIdxBase + subY * 16 + subX) & 0x3FF;
          }

          const z = prio ? zHigh : zLow;
          const localY = flipY ? (7 - (rY & 7)) : (rY & 7);

          const colorFor = (idx) => {
              let globalColorIdx;
              if (bpp === 8) {
                  globalColorIdx = idx; // 256 colors
              } else if (bpp === 4) {
                  // For 16-color BGs, palette ranges 0-7, so palIdx * 16 + pixelColor
                  // If mode 0, offset is handled via paletteOffset
                  globalColorIdx = paletteOffset + (palIdx * 16) + idx;
              } else {
                  // For 4-color BGs
                  globalColorIdx = paletteOffset + (palIdx * 4) + idx;
              }
              return this.getColor(globalColorIdx);
          };

          if (hires && large) {
              // Hi-res BG layer with 16x16 tiles: each 8x8 quadrant subtile
              // (selected above via subX/subY) is pixel-doubled to 16 output
              // columns, same as the non-hires path. Unlike 8x8-tile hires
              // cells, a 16x16 tilemap entry already addresses all 4 subtiles
              // needed to cover its 32-output-column span, so no second
              // "tileIdx+1" character fetch is involved.
              const lx = flipX ? (7 - (rX & 7)) : (rX & 7);
              const pixelColorIdx = this.getTilePixel(tileIdx, lx, localY, bpp, charBase);
              if (pixelColorIdx !== 0) {
                  const color = colorFor(pixelColorIdx);
                  for (let within256 = 0; within256 < 2; within256++) {
                      const ox = x256 * 2 + within256;
                      if (z > this.zBuffer[ox]) {
                          this.frameBuffer[outputOffset + ox] = color;
                          this.zBuffer[ox] = z;
                          this.layerBuffer[ox] = bgIndex; // 1, 2, 3, 4
                      }
                  }
              }
          } else if (hires) {
              // Hi-res BG layer: each 8px tilemap cell addresses a 16px-wide
              // native source built from two adjacent character tiles
              // (tileIdx, tileIdx+1). Render all 16 native columns as 16
              // distinct output pixels (2 per logical x256) to match real
              // hardware's 512px-wide hi-res output.
              for (let within256 = 0; within256 < 2; within256++) {
                  const ox = x256 * 2 + within256;
                  if (z <= this.zBuffer[ox]) continue;

                  let nativeCol = 2 * (rX & 7) + within256;
                  if (flipX) nativeCol = 15 - nativeCol;
                  const tile = nativeCol < 8 ? tileIdx : (tileIdx + 1) & 0x3FF;
                  const lx = nativeCol & 7;

                  const pixelColorIdx = this.getTilePixel(tile, lx, localY, bpp, charBase);
                  if (pixelColorIdx !== 0) {
                      this.frameBuffer[outputOffset + ox] = colorFor(pixelColorIdx);
                      this.zBuffer[ox] = z;
                      this.layerBuffer[ox] = bgIndex; // 1, 2, 3, 4
                  }
              }
          } else {
              // Non-hires BG layer: compute the source pixel once per logical
              // x256, then write it to both output sub-pixels (pixel-doubled
              // to fill the 512px-wide framebuffer).
              const o0 = x256 * 2, o1 = o0 + 1;
              if (z <= this.zBuffer[o0] && z <= this.zBuffer[o1]) continue;

              const localX = flipX ? (7 - (rX & 7)) : (rX & 7);
              const pixelColorIdx = this.getTilePixel(tileIdx, localX, localY, bpp, charBase);
              if (pixelColorIdx !== 0) {
                  const color = colorFor(pixelColorIdx);
                  if (z > this.zBuffer[o0]) {
                      this.frameBuffer[outputOffset + o0] = color;
                      this.zBuffer[o0] = z;
                      this.layerBuffer[o0] = bgIndex; // 1, 2, 3, 4
                  }
                  if (z > this.zBuffer[o1]) {
                      this.frameBuffer[outputOffset + o1] = color;
                      this.zBuffer[o1] = z;
                      this.layerBuffer[o1] = bgIndex; // 1, 2, 3, 4
                  }
              }
          }
      }
  }

  renderMode7(line) {
      // 13-bit signed (sign extend from bit 12)
      const cx = (this.m7x & 0x1FFF) | ((this.m7x & 0x1000) ? ~0x1FFF : 0);
      const cy = (this.m7y & 0x1FFF) | ((this.m7y & 0x1000) ? ~0x1FFF : 0);

      const hScroll = (this.m7hofs & 0x1FFF) | ((this.m7hofs & 0x1000) ? ~0x1FFF : 0);
      const vScroll = (this.m7vofs & 0x1FFF) | ((this.m7vofs & 0x1000) ? ~0x1FFF : 0);

      // 16-bit signed
      const a = (this.m7a << 16) >> 16;
      const b = (this.m7b << 16) >> 16;
      const c = (this.m7c << 16) >> 16;
      const d = (this.m7d << 16) >> 16;

      const flipH = this.m7sel & 0x01;
      const flipV = this.m7sel & 0x02;
      const repeatMode = (this.m7sel >> 6) & 3;

      const sy = line;
      const actualSy = flipV ? (255 - sy) : sy;

      const outputOffset = line * 512;
      const z = 15; // Z depth for Mode 7 BG1 is usually below sprites but above backdrop

      for (let sx = 0; sx < 256; sx++) {
          const actualSx = flipH ? (255 - sx) : sx;

          // Compute matrix transformation
          let xx = ((actualSx + hScroll - cx) * a + (actualSy + vScroll - cy) * b) >> 8;
          xx += cx;

          let yy = ((actualSx + hScroll - cx) * c + (actualSy + vScroll - cy) * d) >> 8;
          yy += cy;

          // Map wrapping / Screen over
          let isOutOfBounds = (xx < 0 || xx > 1023 || yy < 0 || yy > 1023);

          // The Mode 7 map is a 1024x1024 (128x128 tile) space that wraps;
          // mask to that range so out-of-range coordinates (repeat modes 0/1,
          // or the in-range component when xx/yy overflow) don't read tile
          // codes from outside the tilemap area in VRAM.
          let tx = xx & 1023;
          let ty = yy & 1023;
          let pixelColorIdx = 0;

          if (isOutOfBounds && repeatMode === 2) {
              // Transparent outside
              pixelColorIdx = 0;
          } else {
              let tileCode = 0;
              if (isOutOfBounds && repeatMode === 3) {
                  // Tile 0 outside
                  tileCode = 0;
              } else {
                  let tileX = tx >> 3;
                  let tileY = ty >> 3;
                  let mapIndex = tileY * 128 + tileX;
                  tileCode = this.vram[mapIndex * 2]; // Lower byte is tile map
              }

              let px = tx & 7;
              let py = ty & 7;
              let pixelOffset = tileCode * 64 + py * 8 + px;

              pixelColorIdx = this.vram[pixelOffset * 2 + 1]; // Upper byte is pixel data
          }

          if (pixelColorIdx !== 0) {
              // Mode 7 is never hi-res; pixel-double into the 512px framebuffer.
              const color = this.getColor(pixelColorIdx);
              const o0 = sx * 2, o1 = o0 + 1;
              if (z > this.zBuffer[o0]) {
                  this.frameBuffer[outputOffset + o0] = color;
                  this.zBuffer[o0] = z;
                  this.layerBuffer[o0] = 1; // Mode 7 is BG1
              }
              if (z > this.zBuffer[o1]) {
                  this.frameBuffer[outputOffset + o1] = color;
                  this.zBuffer[o1] = z;
                  this.layerBuffer[o1] = 1; // Mode 7 is BG1
              }
          }
      }
  }

  getTilePixel(tileIdx, x, y, bpp, charBase) {
      const tileAddr = (charBase + tileIdx * 8 * bpp) & 0xFFFF;
      const rowParams01 = tileAddr + y * 2;
      const p0 = this.vram[rowParams01 & 0xFFFF];
      const p1 = this.vram[(rowParams01 + 1) & 0xFFFF];

      let pixel = ((p0 >> (7 - x)) & 1) | (((p1 >> (7 - x)) & 1) << 1);

      if (bpp >= 4) {
          const rowParams23 = tileAddr + 16 + y * 2;
          const p2 = this.vram[rowParams23 & 0xFFFF];
          const p3 = this.vram[(rowParams23 + 1) & 0xFFFF];
          pixel |= ((p2 >> (7 - x)) & 1) << 2;
          pixel |= ((p3 >> (7 - x)) & 1) << 3;
      }
      if (bpp === 8) {
          const rowParams45 = tileAddr + 32 + y * 2;
          const p4 = this.vram[rowParams45 & 0xFFFF];
          const p5 = this.vram[(rowParams45 + 1) & 0xFFFF];
          pixel |= ((p4 >> (7 - x)) & 1) << 4;
          pixel |= ((p5 >> (7 - x)) & 1) << 5;
          const rowParams67 = tileAddr + 48 + y * 2;
          const p6 = this.vram[rowParams67 & 0xFFFF];
          const p7 = this.vram[(rowParams67 + 1) & 0xFFFF];
          pixel |= ((p6 >> (7 - x)) & 1) << 6;
          pixel |= ((p7 >> (7 - x)) & 1) << 7;
      }
      return pixel;
  }

  evaluateSprites(line) {
    if (this.inidisp & 0x80) return;

    // OBSEL Logic
    // OBSEL bits 0-2 select the OBJ name-base in 16KB byte steps.
    const nameBase = (this.obsel & 0x07) << 14;
    // OBSEL bits 3-4 select the gap from base name table to the second table.
    // Hardware encoding is (1..4) * 0x2000 bytes.
    const page1Offset = ((((this.obsel >> 3) & 0x03) + 1) << 13);

    // Size Logic (matches Snes9x SetupOBJ)
    const sizeSel = (this.obsel >> 5) & 7;
    let smallW = 8, smallH = 8, largeW = 16, largeH = 16;
    switch (sizeSel) {
        case 0: smallW = 8;  smallH = 8;  largeW = 16; largeH = 16; break;
        case 1: smallW = 8;  smallH = 8;  largeW = 32; largeH = 32; break;
        case 2: smallW = 8;  smallH = 8;  largeW = 64; largeH = 64; break;
        case 3: smallW = 16; smallH = 16; largeW = 32; largeH = 32; break;
        case 4: smallW = 16; smallH = 16; largeW = 64; largeH = 64; break;
        case 5: smallW = 32; smallH = 32; largeW = 64; largeH = 64; break;
        case 6: smallW = 16; smallH = 32; largeW = 32; largeH = 64; break;
        case 7: smallW = 16; smallH = 32; largeW = 32; largeH = 32; break;
    }

    // Iterate 127 down to 0 (Back to Front for internal overwrite)
    for (let i = 127; i >= 0; i--) {
        const addr = i * 4;
        const xLo = this.oam[addr];
        const y = this.oam[addr + 1];
        const tile = this.oam[addr + 2];
        const attr = this.oam[addr + 3];

        const hiByte = this.oam[512 + (i >> 2)];
        const shift = (i & 3) * 2;
        const xHi = (hiByte >> shift) & 1;
        const sizeFlag = (hiByte >> (shift + 1)) & 1;

        let x = xLo | (xHi << 8);
        if (x > 255) x -= 512;

        const width = sizeFlag ? largeW : smallW;
        const height = sizeFlag ? largeH : smallH;

        const difY = (line - y) & 0xFF;

        // Visibility Check
        if (difY >= height) continue;

        const flipY = (attr & 0x80) !== 0;
        const flipX = (attr & 0x40) !== 0;
        const paletteBase = 128 + ((attr >> 1) & 7) * 16; // bits 3-1 = palette (0-7)
        const priority = (attr >> 4) & 3;                  // bits 5-4 = priority
        const page = attr & 1;                             // bit 0 = name table select

        // Vertical flip must use sprite height (rectangular OBJ modes have width != height).
        const row = difY;
        const actualRow = flipY ? (row ^ (height - 1)) : row;

        const tileRowOffset = (actualRow >> 3);
        const rowInTile = actualRow & 7;

        const name = ((attr & 1) << 8) | tile;
        const rowTileOffset = (actualRow >> 3) << 4;

        for (let col = 0; col < width; col++) {
            const px = x + col;

            if (px < 0 || px >= 256) continue;

            const actualCol = flipX ? (width - 1 - col) : col;
            const tileColOffset = (actualCol >> 3);
            const colInTile = actualCol & 7;

            // Keep full 9-bit tile arithmetic so nibble overflow carries into page select.
            const tileIndex = (name + rowTileOffset + tileColOffset) & 0x1FF;
            const tableAddr = nameBase + ((tileIndex & 0x100) ? page1Offset : 0);
            const tileAddr = tableAddr + ((tileIndex & 0xFF) * 32);

            const p0Addr = (tileAddr + rowInTile * 2) & 0xFFFF;
            const p1Addr = (tileAddr + 16 + rowInTile * 2) & 0xFFFF;

            const p0 = this.vram[p0Addr];
            const p1 = this.vram[p0Addr + 1];
            const p2 = this.vram[p1Addr];
            const p3 = this.vram[p1Addr + 1];

            const bitShift = 7 - colInTile;
            const bit0 = (p0 >> bitShift) & 1;
            const bit1 = (p1 >> bitShift) & 1;
            const bit2 = (p2 >> bitShift) & 1;
            const bit3 = (p3 >> bitShift) & 1;

            const colorIdx = bit0 | (bit1 << 1) | (bit2 << 2) | (bit3 << 3);

            if (colorIdx !== 0) {
                // Populate Line Buffer
                // Since we iterate 127 -> 0, the last write (lowest index) wins.
                // This matches SNES behavior where lower index = higher priority.
                // The priority attribute only controls Z-depth against BG, not Sprite-vs-Sprite.

                const finalColor = this.getColor(paletteBase + colorIdx);
                const palHigh = ((attr >> 1) & 7) >= 4 ? 1 : 0; // palette 4-7 = color math eligible
                // Sprites are never hi-res; pixel-double into the 512px buffers.
                const o0 = px * 2, o1 = o0 + 1;
                this.objBuffer[o0] = finalColor;
                this.objBuffer[o1] = finalColor;
                this.objPrioBuffer[o0] = priority;
                this.objPrioBuffer[o1] = priority;
                this.objPalHighBuffer[o0] = palHigh;
                this.objPalHighBuffer[o1] = palHigh;
            }
        }
    }
  }
}

exports.PPU = PPU;

};

registry['APU'] = function(module,exports,require) {
const DSP = require('./DSP').DSP;

class APU {
  constructor() {
    this.ram = new Uint8Array(64 * 1024);
    this.dsp = new DSP();
    this.dsp.setApuRam(this.ram);
    this.bootRom = new Uint8Array([ // IPL ROM
        0xcd, 0xef, 0xbd, 0xe8, 0x00, 0xc6, 0x1d, 0xd0, 0xfc, 0x8f, 0xaa, 0xf4, 0x8f, 0xbb, 0xf5, 0x78,
        0xcc, 0xf4, 0xd0, 0xfb, 0x2f, 0x19, 0xeb, 0xf4, 0xd0, 0xfc, 0x7e, 0xf4, 0xd0, 0x0b, 0xe4, 0xf5,
        0xcb, 0xf4, 0xd7, 0x00, 0xfc, 0xd0, 0xf3, 0xab, 0x01, 0x10, 0xef, 0x7e, 0xf4, 0x10, 0xeb, 0xba,
        0xf6, 0xda, 0x00, 0xba, 0xf4, 0xc4, 0xf4, 0xdd, 0x5d, 0xd0, 0xdb, 0x1f, 0x00, 0x00, 0xc0, 0xff
    ]);

    this.PC = 0xFFC0;
    this.A = 0; this.X = 0; this.Y = 0; this.SP = 0xEF; this.PSW = 0x02;

    this.cpuPorts = new Uint8Array(4);
    this.cpuPortsLatch = new Uint8Array(4); // last CPU-written value (survives CONTROL clears)
    this.apuPorts = new Uint8Array(4);

    this.timers = [ {ticks:0, counter:0}, {ticks:0, counter:0}, {ticks:0, counter:0} ];
    this.timerTargets = new Uint8Array(3);
    this.timersEnabled = 0;
    this.counter0 = 0; this.counter1 = 0; this.counter2 = 0;
    this.control = 0x80; this.dspAddr = 0; this.dspData = 0; this.testReg = 0;
    this.cycles = 0;
    this._cpuRefCycles = 0;
    this._syncRemainder = 0;

    this.initOpcodes();
  }

  reset() {
      this.ram.fill(0);
      this.apuPorts.fill(0); this.cpuPorts.fill(0);
      this.cpuPortsLatch.fill(0);
      this.PC = 0xFFC0; this.A = 0; this.X = 0; this.Y = 0; this.SP = 0xEF; this.PSW = 0x02;
    this.control = 0x80; this.timersEnabled = 0; this.timerTargets.fill(0x00);
      this.timers = [ {ticks:0, counter:0}, {ticks:0, counter:0}, {ticks:0, counter:0} ]; this.counter0 = 0; this.counter1 = 0; this.counter2 = 0;
      this.dsp.reset();
      this.dspAddr = 0; this.dspData = 0; this.cycles = 0;
      this.dspCycles = 0;
      this._cpuRefCycles = 0;
      this._syncRemainder = 0;
  }

  // Snes9x-like synchronization: advance SMP using CPU cycle delta.
  // APU:CPU master-clock ratio is approximately 1024:3580.
  syncToCpuCycles(cpuCycles) {
      const now = cpuCycles | 0;
      let delta = now - this._cpuRefCycles;
      if (delta <= 0) return;

      const scaled = delta * 1024 + this._syncRemainder;
      const apuCycles = Math.floor(scaled / 3580);
      this._syncRemainder = scaled % 3580;
      this._cpuRefCycles = now;

      if (apuCycles <= 0) return;
      const target = this.cycles + apuCycles;
      while (this.cycles < target) this.step();
  }

  readCPU(port) {
      return this.apuPorts[port & 3];
  }
  writeCPU(port, val) {
    // Optional ring-buffer recorder of CPU->APU port writes.
    // Enable: globalThis._portLog = []; globalThis._portLogEnabled = true;
    // Inspect: copy(JSON.stringify(_portLog))
    if (globalThis._portLogEnabled && globalThis._portLog) {
        const cpuRef = globalThis._snesCPU;
        const pc = cpuRef ? ((cpuRef.PB << 16) | (cpuRef._opPC || cpuRef.PC)) : 0;
        globalThis._portLog.push([globalThis._snesFrame|0, port, val, pc]);
        if (globalThis._portLog.length > 50000) globalThis._portLog.shift();
    }
        const index = port & 3;
        this.cpuPorts[index] = val;
        this.cpuPortsLatch[index] = val;
  }

  read(addr) {
      if (addr >= 0x00F0 && addr <= 0x00FF) {
          const port = addr & 0xFF;
          switch (port) {
              case 0xF0: return 0; // TEST (write-only, reads 0)
              case 0xF1: return 0; // CONTROL (write-only, reads 0)
              case 0xF2: return this.dspAddr;
              case 0xF3: return this.dsp.read(this.dspAddr & 0x7F);
                case 0xF4: case 0xF5: case 0xF6: case 0xF7: return this.cpuPorts[port - 0xF4];
              case 0xF8: case 0xF9: return this.ram[port];
              case 0xFA: case 0xFB: case 0xFC: return 0; // Timer targets (write-only)
              case 0xFD: { let r = this.counter0; this.counter0 = 0; return r; }
              case 0xFE: { let r = this.counter1; this.counter1 = 0; return r; }
              case 0xFF: { let r = this.counter2; this.counter2 = 0; return r; }
          }
      }
      if (addr >= 0xFFC0 && (this.control & 0x80)) { return this.bootRom[addr - 0xFFC0]; }
      return this.ram[addr];
  }

  write(addr, val) {
      if (addr >= 0x00F0 && addr <= 0x00FF) {
          const port = addr & 0xFF;
          switch (port) {
              case 0xF0: this.testReg = val; break;
              case 0xF1:
                  let newEnabled = val & 0x07;
                  for (let i = 0; i < 3; i++) {
                      if ((newEnabled & (1 << i)) && !(this.timersEnabled & (1 << i))) {
                          this.timers[i].ticks = 0;
                          this.timers[i].counter = 0;
                          if (i === 0) this.counter0 = 0;
                          if (i === 1) this.counter1 = 0;
                          if (i === 2) this.counter2 = 0;
                      }
                  }
                  this.timersEnabled = newEnabled;
                  // CONTROL bits 4/5: clear CPU-written input ports as seen by SPC.
                  // Real hardware: writing 1 to bit 4 zeroes $F4/$F5 input latches,
                  // bit 5 zeroes $F6/$F7. This is how IPL acknowledges handshake bytes.
                  if (val & 0x10) {
                      this.ram[0xF4] = 0; this.ram[0xF5] = 0;
                      this.cpuPorts[0] = 0; this.cpuPorts[1] = 0;
                      this.cpuPortsLatch[0] = 0; this.cpuPortsLatch[1] = 0;
                  }
                  if (val & 0x20) {
                      this.ram[0xF6] = 0; this.ram[0xF7] = 0;
                      this.cpuPorts[2] = 0; this.cpuPorts[3] = 0;
                      this.cpuPortsLatch[2] = 0; this.cpuPortsLatch[3] = 0;
                  }
                  this.control = val;
                  break;
              case 0xF2: this.dspAddr = val; break;
              case 0xF3:
                  this.dspData = val;
                  if (this.dspAddr & 0x80) break;
                  // Detailed logging for DSP VOL writes
                  if (globalThis._dmaLog && ((this.dspAddr & 0x7F) === 0x0C || (this.dspAddr & 0x7F) === 0x0D || (this.dspAddr & 0x7F) === 0x1C || (this.dspAddr & 0x7F) === 0x1D || (this.dspAddr & 0x7F) === 0x2C || (this.dspAddr & 0x7F) === 0x2D || (this.dspAddr & 0x7F) === 0x3C || (this.dspAddr & 0x7F) === 0x3D)) {
                      const stack = (new Error()).stack.split('\n').slice(2, 7).join(' | ');
                      const pc = (typeof this.PC === 'number') ? this.PC.toString(16).padStart(4, '0') : '????';
                      console.log(`[APU] DSP VOL write: addr=0x${(this.dspAddr & 0x7F).toString(16)} value=0x${val.toString(16)} PC=0x${pc} stack=${stack}`);
                  }
                  this.dsp.write(this.dspAddr & 0x7F, val);
                  break;
              case 0xF4: case 0xF5: case 0xF6: case 0xF7:
                  this.apuPorts[port - 0xF4] = val;
                  this.ram[port] = val;
                  break;
              case 0xF8: case 0xF9: this.ram[port] = val; break;
              case 0xFA: this.timerTargets[0] = val; break;
              case 0xFB: this.timerTargets[1] = val; break;
              case 0xFC: this.timerTargets[2] = val; break;
          }
          // Match Snes9x SMP behavior: MMIO writes are also visible in APURAM.
          this.ram[addr] = val;
          return;
      }
      this.ram[addr] = val;
  }

  // --- Stack ---
  push(val) { this.write(0x0100 | this.SP, val); this.SP = (this.SP - 1) & 0xFF; }
  pop() { this.SP = (this.SP + 1) & 0xFF; return this.read(0x0100 | this.SP); }
  push16(val) { this.push((val >> 8) & 0xFF); this.push(val & 0xFF); }
  pop16() { let lo = this.pop(); let hi = this.pop(); return (hi << 8) | lo; }

  // --- Status Flags ---
  getFlag(flag) { return (this.PSW & flag) !== 0; }
  setFlag(flag, condition) { if (condition) this.PSW |= flag; else this.PSW &= ~flag; }
  setFlags(val) { this.setFlag(0x02, (val & 0xFF) === 0); this.setFlag(0x80, val & 0x80); }

  // --- Fetchers & Addressing ---
  fetch() { const val = this.read(this.PC); this.PC = (this.PC + 1) & 0xFFFF; return val; }
  fetch16() { const lo = this.fetch(); const hi = this.fetch(); return (hi << 8) | lo; }

  getDPBase() { return (this.PSW & 0x20) ? 0x0100 : 0x0000; }

  addr_dp() { return this.fetch() | this.getDPBase(); }
  addr_dp_x() { return ((this.fetch() + this.X) & 0xFF) | this.getDPBase(); }
  addr_dp_y() { return ((this.fetch() + this.Y) & 0xFF) | this.getDPBase(); }
  addr_abs() { return this.fetch16(); }
  addr_abs_x() { return (this.fetch16() + this.X) & 0xFFFF; }
  addr_abs_y() { return (this.fetch16() + this.Y) & 0xFFFF; }
  addr_ind_x() { return this.X | this.getDPBase(); }
  addr_ind_dp_x() { let dp = ((this.fetch() + this.X) & 0xFF) | this.getDPBase(); return this.read(dp) | (this.read((dp & 0xFF00) | ((dp + 1) & 0xFF)) << 8); }
  addr_ind_dp_y() { let dp = this.fetch() | this.getDPBase(); let ptr = this.read(dp) | (this.read((dp & 0xFF00) | ((dp + 1) & 0xFF)) << 8); return (ptr + this.Y) & 0xFFFF; }
  addr_ind_x_inc() { let a = this.X | this.getDPBase(); this.X = (this.X + 1) & 0xFF; return a; }

  step() {
      let prevCycles = this.cycles;
      const opcode = this.fetch();
      this.opcodes[opcode]();

      let delta = this.cycles - prevCycles;
      if (delta <= 0) delta = 2; // fallback

      if (!this.dspCycles) this.dspCycles = 0;
      this.dspCycles += delta;

      // Step timers (every 1 APU cycle)
      for(let i=0; i<3; i++) {
         if ((this.timersEnabled & (1 << i))) {
             this.timers[i].ticks += delta;
             let limit = (i === 2) ? 16 : 128; // Timer 0,1 run every 128 cycles, Timer 2 runs every 16 cycles
             while (this.timers[i].ticks >= limit) {
                 this.timers[i].ticks -= limit;
                 this.timers[i].counter++;
                 let target = this.timerTargets[i] === 0 ? 256 : this.timerTargets[i];
                 if (this.timers[i].counter >= target) {
                     this.timers[i].counter -= target;
                     if (i === 0) this.counter0 = (this.counter0 + 1) & 0x0F;
                     if (i === 1) this.counter1 = (this.counter1 + 1) & 0x0F;
                     if (i === 2) this.counter2 = (this.counter2 + 1) & 0x0F;
                 }
             }
         }
      }

      // Step DSP
      while (this.dspCycles >= 32) {
          this.dspCycles -= 32;
          this.dsp.step();
      }
  }

  initOpcodes() {
      this.opcodes = new Array(256);
      for (let i = 0; i < 256; i++) {
          this.opcodes[i] = () => { this.cycles += 2; }; // Fallback NOP
      }

      const OP = (code, fn) => { this.opcodes[code] = fn.bind(this); };

      // Helper for relative branches
      const branch = (cond) => {
          let rel = this.fetch();
          if (rel > 127) rel -= 256;
          if (cond) { this.PC = (this.PC + rel) & 0xFFFF; this.cycles += 4; }
          else { this.cycles += 2; }
      };

      // Helper: dp+1 address staying within same DP page
      const dpNext = (dp) => (dp & 0xFF00) | ((dp + 1) & 0xFF);

      // ========================
      // MOV Instructions
      // ========================
      // Load immediate
      OP(0xE8, function() { this.A = this.fetch(); this.setFlags(this.A); this.cycles+=2; }); // MOV A,#imm
      OP(0xCD, function() { this.X = this.fetch(); this.setFlags(this.X); this.cycles+=2; }); // MOV X,#imm
      OP(0x8D, function() { this.Y = this.fetch(); this.setFlags(this.Y); this.cycles+=2; }); // MOV Y,#imm
      // A from memory
      OP(0xE4, function() { this.A = this.read(this.addr_dp()); this.setFlags(this.A); this.cycles+=3; }); // MOV A,dp
      OP(0xF4, function() { this.A = this.read(this.addr_dp_x()); this.setFlags(this.A); this.cycles+=4; }); // MOV A,dp+X
      OP(0xE5, function() { this.A = this.read(this.addr_abs()); this.setFlags(this.A); this.cycles+=4; }); // MOV A,abs
      OP(0xF5, function() { this.A = this.read(this.addr_abs_x()); this.setFlags(this.A); this.cycles+=5; }); // MOV A,abs+X
      OP(0xF6, function() { this.A = this.read(this.addr_abs_y()); this.setFlags(this.A); this.cycles+=5; }); // MOV A,abs+Y
      OP(0xE6, function() { this.A = this.read(this.addr_ind_x()); this.setFlags(this.A); this.cycles+=3; }); // MOV A,(X)
      OP(0xBF, function() { this.A = this.read(this.addr_ind_x_inc()); this.setFlags(this.A); this.cycles+=4; }); // MOV A,(X)+
      OP(0xE7, function() { this.A = this.read(this.addr_ind_dp_x()); this.setFlags(this.A); this.cycles+=6; }); // MOV A,[dp+X]
      OP(0xF7, function() { this.A = this.read(this.addr_ind_dp_y()); this.setFlags(this.A); this.cycles+=6; }); // MOV A,[dp]+Y
      // A to memory
      OP(0xC4, function() { this.write(this.addr_dp(), this.A); this.cycles+=4; }); // MOV dp,A
      OP(0xD4, function() { this.write(this.addr_dp_x(), this.A); this.cycles+=5; }); // MOV dp+X,A
      OP(0xC5, function() { this.write(this.addr_abs(), this.A); this.cycles+=5; }); // MOV abs,A
      OP(0xD5, function() { this.write(this.addr_abs_x(), this.A); this.cycles+=6; }); // MOV abs+X,A
      OP(0xD6, function() { this.write(this.addr_abs_y(), this.A); this.cycles+=6; }); // MOV abs+Y,A
      OP(0xC6, function() { this.write(this.addr_ind_x(), this.A); this.cycles+=4; }); // MOV (X),A
      OP(0xAF, function() { this.write(this.addr_ind_x_inc(), this.A); this.cycles+=4; }); // MOV (X)+,A
      OP(0xC7, function() { this.write(this.addr_ind_dp_x(), this.A); this.cycles+=7; }); // MOV [dp+X],A
      OP(0xD7, function() { this.write(this.addr_ind_dp_y(), this.A); this.cycles+=7; }); // MOV [dp]+Y,A
      // X from/to memory
      OP(0xF8, function() { this.X = this.read(this.addr_dp()); this.setFlags(this.X); this.cycles+=3; }); // MOV X,dp
      OP(0xF9, function() { this.X = this.read(this.addr_dp_y()); this.setFlags(this.X); this.cycles+=4; }); // MOV X,dp+Y
      OP(0xE9, function() { this.X = this.read(this.addr_abs()); this.setFlags(this.X); this.cycles+=4; }); // MOV X,abs
      OP(0xD8, function() { this.write(this.addr_dp(), this.X); this.cycles+=4; }); // MOV dp,X
      OP(0xD9, function() { this.write(this.addr_dp_y(), this.X); this.cycles+=5; }); // MOV dp+Y,X
      OP(0xC9, function() { this.write(this.addr_abs(), this.X); this.cycles+=5; }); // MOV abs,X
      // Y from/to memory
      OP(0xEB, function() { this.Y = this.read(this.addr_dp()); this.setFlags(this.Y); this.cycles+=3; }); // MOV Y,dp
      OP(0xFB, function() { this.Y = this.read(this.addr_dp_x()); this.setFlags(this.Y); this.cycles+=4; }); // MOV Y,dp+X
      OP(0xEC, function() { this.Y = this.read(this.addr_abs()); this.setFlags(this.Y); this.cycles+=4; }); // MOV Y,abs
      OP(0xCB, function() { this.write(this.addr_dp(), this.Y); this.cycles+=4; }); // MOV dp,Y
      OP(0xDB, function() { this.write(this.addr_dp_x(), this.Y); this.cycles+=5; }); // MOV dp+X,Y
      OP(0xCC, function() { this.write(this.addr_abs(), this.Y); this.cycles+=5; }); // MOV abs,Y
      // Register transfers
      OP(0x5D, function() { this.X = this.A; this.setFlags(this.X); this.cycles+=2; }); // MOV X,A
      OP(0x7D, function() { this.A = this.X; this.setFlags(this.A); this.cycles+=2; }); // MOV A,X
      OP(0xDD, function() { this.A = this.Y; this.setFlags(this.A); this.cycles+=2; }); // MOV A,Y
      OP(0xFD, function() { this.Y = this.A; this.setFlags(this.Y); this.cycles+=2; }); // MOV Y,A
      OP(0x9D, function() { this.X = this.SP; this.setFlags(this.X); this.cycles+=2; }); // MOV X,SP
      OP(0xBD, function() { this.SP = this.X; this.cycles+=2; }); // MOV SP,X
      // MOV dp,dp
      OP(0xFA, function() { let s=this.fetch()|this.getDPBase(); let d=this.fetch()|this.getDPBase(); this.write(d, this.read(s)); this.cycles+=5; });
      // MOV dp,#imm
      OP(0x8F, function() { let imm=this.fetch(); let dp=this.addr_dp(); this.write(dp, imm); this.cycles+=5; });

      // ========================
      // Word Operations
      // ========================
      OP(0xBA, function() { let dp=this.addr_dp(); this.A=this.read(dp); this.Y=this.read(dpNext(dp)); let ya=(this.Y<<8)|this.A; this.setFlag(0x02, ya===0); this.setFlag(0x80, this.Y&0x80); this.cycles+=5; }); // MOVW YA,dp
      OP(0xDA, function() { let dp=this.addr_dp(); this.write(dp, this.A); this.write(dpNext(dp), this.Y); this.cycles+=4; }); // MOVW dp,YA
      OP(0x1A, function() { let dp=this.addr_dp(); let val=this.read(dp)|(this.read(dpNext(dp))<<8); val=(val-1)&0xFFFF; this.write(dp,val&0xFF); this.write(dpNext(dp),val>>8); this.setFlag(0x80, val&0x8000); this.setFlag(0x02, val===0); this.cycles+=6; }); // DECW dp
      OP(0x3A, function() { let dp=this.addr_dp(); let val=this.read(dp)|(this.read(dpNext(dp))<<8); val=(val+1)&0xFFFF; this.write(dp,val&0xFF); this.write(dpNext(dp),val>>8); this.setFlag(0x80, val&0x8000); this.setFlag(0x02, val===0); this.cycles+=6; }); // INCW dp
      OP(0x7A, function() { let dp=this.addr_dp(); let val=this.read(dp)|(this.read(dpNext(dp))<<8); let ya=(this.Y<<8)|this.A; let r=ya+val; this.A=r&0xFF; this.Y=(r>>8)&0xFF; this.setFlag(0x80, r&0x8000); this.setFlag(0x02, (r&0xFFFF)===0); this.setFlag(1, r>0xFFFF); this.setFlag(0x40, ~(ya^val)&(ya^r)&0x8000); this.setFlag(8, ((ya&0xFFF)+(val&0xFFF))>0xFFF); this.cycles+=5; }); // ADDW YA,dp
      OP(0x9A, function() { let dp=this.addr_dp(); let val=this.read(dp)|(this.read(dpNext(dp))<<8); let ya=(this.Y<<8)|this.A; let r=ya-val; this.A=r&0xFF; this.Y=(r>>8)&0xFF; this.setFlag(0x80, r&0x8000); this.setFlag(0x02, (r&0xFFFF)===0); this.setFlag(1, r>=0); this.setFlag(0x40, (ya^val)&(ya^r)&0x8000); this.setFlag(8, ((ya&0xFFF)-(val&0xFFF))>=0); this.cycles+=5; }); // SUBW YA,dp
      OP(0x5A, function() { let dp=this.addr_dp(); let val=this.read(dp)|(this.read(dpNext(dp))<<8); let ya=(this.Y<<8)|this.A; let r=ya-val; this.setFlag(0x80, r&0x8000); this.setFlag(0x02, (r&0xFFFF)===0); this.setFlag(1, r>=0); this.cycles+=4; }); // CMPW YA,dp

      // ========================
      // ALU: ADC
      // ========================
      { const adc = (a,b) => { let c=(this.PSW&1)?1:0; let r=a+b+c; this.setFlags(r&0xFF); this.setFlag(1, r>255); this.setFlag(0x40, ~(a^b)&(a^r)&0x80); this.setFlag(8, ((a&0xf)+(b&0xf)+c)>0xf); return r&0xFF; };
        OP(0x88, function() { this.A = adc(this.A, this.fetch()); this.cycles+=2; }); // ADC A,#imm
        OP(0x84, function() { this.A = adc(this.A, this.read(this.addr_dp())); this.cycles+=3; }); // ADC A,dp
        OP(0x94, function() { this.A = adc(this.A, this.read(this.addr_dp_x())); this.cycles+=4; }); // ADC A,dp+X
        OP(0x85, function() { this.A = adc(this.A, this.read(this.addr_abs())); this.cycles+=4; }); // ADC A,abs
        OP(0x95, function() { this.A = adc(this.A, this.read(this.addr_abs_x())); this.cycles+=5; }); // ADC A,abs+X
        OP(0x96, function() { this.A = adc(this.A, this.read(this.addr_abs_y())); this.cycles+=5; }); // ADC A,abs+Y
        OP(0x86, function() { this.A = adc(this.A, this.read(this.addr_ind_x())); this.cycles+=3; }); // ADC A,(X)
        OP(0x87, function() { this.A = adc(this.A, this.read(this.addr_ind_dp_x())); this.cycles+=6; }); // ADC A,[dp+X]
        OP(0x97, function() { this.A = adc(this.A, this.read(this.addr_ind_dp_y())); this.cycles+=6; }); // ADC A,[dp]+Y
        OP(0x98, function() { let imm=this.fetch(); let dp=this.addr_dp(); this.write(dp, adc(this.read(dp), imm)); this.cycles+=5; }); // ADC dp,#imm
        OP(0x89, function() { let s=this.fetch()|this.getDPBase(); let d=this.fetch()|this.getDPBase(); this.write(d, adc(this.read(d), this.read(s))); this.cycles+=6; }); // ADC dp,dp
        OP(0x99, function() { let x=this.X|this.getDPBase(); let y=this.Y|this.getDPBase(); this.write(x, adc(this.read(x), this.read(y))); this.cycles+=5; }); // ADC (X),(Y)
      }

      // ========================
      // ALU: SBC
      // ========================
      { const sbc = (a,b) => { let c=(this.PSW&1)?0:1; let r=a-b-c; this.setFlags(r&0xFF); this.setFlag(1, r>=0); this.setFlag(0x40, (a^b)&(a^r)&0x80); this.setFlag(8, ((a&0xf)-(b&0xf)-c)>=0); return r&0xFF; };
        OP(0xA8, function() { this.A = sbc(this.A, this.fetch()); this.cycles+=2; }); // SBC A,#imm
        OP(0xA4, function() { this.A = sbc(this.A, this.read(this.addr_dp())); this.cycles+=3; }); // SBC A,dp
        OP(0xB4, function() { this.A = sbc(this.A, this.read(this.addr_dp_x())); this.cycles+=4; }); // SBC A,dp+X
        OP(0xA5, function() { this.A = sbc(this.A, this.read(this.addr_abs())); this.cycles+=4; }); // SBC A,abs
        OP(0xB5, function() { this.A = sbc(this.A, this.read(this.addr_abs_x())); this.cycles+=5; }); // SBC A,abs+X
        OP(0xB6, function() { this.A = sbc(this.A, this.read(this.addr_abs_y())); this.cycles+=5; }); // SBC A,abs+Y
        OP(0xA6, function() { this.A = sbc(this.A, this.read(this.addr_ind_x())); this.cycles+=3; }); // SBC A,(X)
        OP(0xA7, function() { this.A = sbc(this.A, this.read(this.addr_ind_dp_x())); this.cycles+=6; }); // SBC A,[dp+X]
        OP(0xB7, function() { this.A = sbc(this.A, this.read(this.addr_ind_dp_y())); this.cycles+=6; }); // SBC A,[dp]+Y
        OP(0xB8, function() { let imm=this.fetch(); let dp=this.addr_dp(); this.write(dp, sbc(this.read(dp), imm)); this.cycles+=5; }); // SBC dp,#imm
        OP(0xA9, function() { let s=this.fetch()|this.getDPBase(); let d=this.fetch()|this.getDPBase(); this.write(d, sbc(this.read(d), this.read(s))); this.cycles+=6; }); // SBC dp,dp
        OP(0xB9, function() { let x=this.X|this.getDPBase(); let y=this.Y|this.getDPBase(); this.write(x, sbc(this.read(x), this.read(y))); this.cycles+=5; }); // SBC (X),(Y)
      }

      // ========================
      // ALU: CMP
      // ========================
      { const cmp = (a,b) => { let r=a-b; this.setFlags(r&0xFF); this.setFlag(1, r>=0); };
        OP(0x68, function() { cmp(this.A, this.fetch()); this.cycles+=2; }); // CMP A,#imm
        OP(0x64, function() { cmp(this.A, this.read(this.addr_dp())); this.cycles+=3; }); // CMP A,dp
        OP(0x74, function() { cmp(this.A, this.read(this.addr_dp_x())); this.cycles+=4; }); // CMP A,dp+X
        OP(0x65, function() { cmp(this.A, this.read(this.addr_abs())); this.cycles+=4; }); // CMP A,abs
        OP(0x75, function() { cmp(this.A, this.read(this.addr_abs_x())); this.cycles+=5; }); // CMP A,abs+X
        OP(0x76, function() { cmp(this.A, this.read(this.addr_abs_y())); this.cycles+=5; }); // CMP A,abs+Y
        OP(0x66, function() { cmp(this.A, this.read(this.addr_ind_x())); this.cycles+=3; }); // CMP A,(X)
        OP(0x67, function() { cmp(this.A, this.read(this.addr_ind_dp_x())); this.cycles+=6; }); // CMP A,[dp+X]
        OP(0x77, function() { cmp(this.A, this.read(this.addr_ind_dp_y())); this.cycles+=6; }); // CMP A,[dp]+Y
        OP(0x78, function() { let imm=this.fetch(); let dp=this.addr_dp(); cmp(this.read(dp), imm); this.cycles+=5; }); // CMP dp,#imm
        OP(0x69, function() { let s=this.fetch()|this.getDPBase(); let d=this.fetch()|this.getDPBase(); cmp(this.read(d), this.read(s)); this.cycles+=6; }); // CMP dp,dp
        OP(0x79, function() { let x=this.X|this.getDPBase(); let y=this.Y|this.getDPBase(); cmp(this.read(x), this.read(y)); this.cycles+=5; }); // CMP (X),(Y)
        OP(0xC8, function() { cmp(this.X, this.fetch()); this.cycles+=2; }); // CMP X,#imm
        OP(0x3E, function() { cmp(this.X, this.read(this.addr_dp())); this.cycles+=3; }); // CMP X,dp
        OP(0x1E, function() { cmp(this.X, this.read(this.addr_abs())); this.cycles+=4; }); // CMP X,abs
        OP(0xAD, function() { cmp(this.Y, this.fetch()); this.cycles+=2; }); // CMP Y,#imm
        OP(0x7E, function() { cmp(this.Y, this.read(this.addr_dp())); this.cycles+=3; }); // CMP Y,dp
        OP(0x5E, function() { cmp(this.Y, this.read(this.addr_abs())); this.cycles+=4; }); // CMP Y,abs
      }

      // ========================
      // ALU: AND
      // ========================
      { const and = (a,b) => { let r=a&b; this.setFlags(r); return r; };
        OP(0x28, function() { this.A = and(this.A, this.fetch()); this.cycles+=2; }); // AND A,#imm
        OP(0x24, function() { this.A = and(this.A, this.read(this.addr_dp())); this.cycles+=3; }); // AND A,dp
        OP(0x34, function() { this.A = and(this.A, this.read(this.addr_dp_x())); this.cycles+=4; }); // AND A,dp+X
        OP(0x25, function() { this.A = and(this.A, this.read(this.addr_abs())); this.cycles+=4; }); // AND A,abs
        OP(0x35, function() { this.A = and(this.A, this.read(this.addr_abs_x())); this.cycles+=5; }); // AND A,abs+X
        OP(0x36, function() { this.A = and(this.A, this.read(this.addr_abs_y())); this.cycles+=5; }); // AND A,abs+Y
        OP(0x26, function() { this.A = and(this.A, this.read(this.addr_ind_x())); this.cycles+=3; }); // AND A,(X)
        OP(0x27, function() { this.A = and(this.A, this.read(this.addr_ind_dp_x())); this.cycles+=6; }); // AND A,[dp+X]
        OP(0x37, function() { this.A = and(this.A, this.read(this.addr_ind_dp_y())); this.cycles+=6; }); // AND A,[dp]+Y
        OP(0x38, function() { let imm=this.fetch(); let dp=this.addr_dp(); this.write(dp, and(this.read(dp), imm)); this.cycles+=5; }); // AND dp,#imm
        OP(0x29, function() { let s=this.fetch()|this.getDPBase(); let d=this.fetch()|this.getDPBase(); this.write(d, and(this.read(d), this.read(s))); this.cycles+=6; }); // AND dp,dp
        OP(0x39, function() { let x=this.X|this.getDPBase(); let y=this.Y|this.getDPBase(); this.write(x, and(this.read(x), this.read(y))); this.cycles+=5; }); // AND (X),(Y)
      }

      // ========================
      // ALU: OR
      // ========================
      { const or = (a,b) => { let r=a|b; this.setFlags(r); return r; };
        OP(0x08, function() { this.A = or(this.A, this.fetch()); this.cycles+=2; }); // OR A,#imm
        OP(0x04, function() { this.A = or(this.A, this.read(this.addr_dp())); this.cycles+=3; }); // OR A,dp
        OP(0x14, function() { this.A = or(this.A, this.read(this.addr_dp_x())); this.cycles+=4; }); // OR A,dp+X
        OP(0x05, function() { this.A = or(this.A, this.read(this.addr_abs())); this.cycles+=4; }); // OR A,abs
        OP(0x15, function() { this.A = or(this.A, this.read(this.addr_abs_x())); this.cycles+=5; }); // OR A,abs+X
        OP(0x16, function() { this.A = or(this.A, this.read(this.addr_abs_y())); this.cycles+=5; }); // OR A,abs+Y
        OP(0x06, function() { this.A = or(this.A, this.read(this.addr_ind_x())); this.cycles+=3; }); // OR A,(X)
        OP(0x07, function() { this.A = or(this.A, this.read(this.addr_ind_dp_x())); this.cycles+=6; }); // OR A,[dp+X]
        OP(0x17, function() { this.A = or(this.A, this.read(this.addr_ind_dp_y())); this.cycles+=6; }); // OR A,[dp]+Y
        OP(0x18, function() { let imm=this.fetch(); let dp=this.addr_dp(); this.write(dp, or(this.read(dp), imm)); this.cycles+=5; }); // OR dp,#imm
        OP(0x09, function() { let s=this.fetch()|this.getDPBase(); let d=this.fetch()|this.getDPBase(); this.write(d, or(this.read(d), this.read(s))); this.cycles+=6; }); // OR dp,dp
        OP(0x19, function() { let x=this.X|this.getDPBase(); let y=this.Y|this.getDPBase(); this.write(x, or(this.read(x), this.read(y))); this.cycles+=5; }); // OR (X),(Y)
      }

      // ========================
      // ALU: EOR
      // ========================
      { const eor = (a,b) => { let r=a^b; this.setFlags(r); return r; };
        OP(0x48, function() { this.A = eor(this.A, this.fetch()); this.cycles+=2; }); // EOR A,#imm
        OP(0x44, function() { this.A = eor(this.A, this.read(this.addr_dp())); this.cycles+=3; }); // EOR A,dp
        OP(0x54, function() { this.A = eor(this.A, this.read(this.addr_dp_x())); this.cycles+=4; }); // EOR A,dp+X
        OP(0x45, function() { this.A = eor(this.A, this.read(this.addr_abs())); this.cycles+=4; }); // EOR A,abs
        OP(0x55, function() { this.A = eor(this.A, this.read(this.addr_abs_x())); this.cycles+=5; }); // EOR A,abs+X
        OP(0x56, function() { this.A = eor(this.A, this.read(this.addr_abs_y())); this.cycles+=5; }); // EOR A,abs+Y
        OP(0x46, function() { this.A = eor(this.A, this.read(this.addr_ind_x())); this.cycles+=3; }); // EOR A,(X)
        OP(0x47, function() { this.A = eor(this.A, this.read(this.addr_ind_dp_x())); this.cycles+=6; }); // EOR A,[dp+X]
        OP(0x57, function() { this.A = eor(this.A, this.read(this.addr_ind_dp_y())); this.cycles+=6; }); // EOR A,[dp]+Y
        OP(0x58, function() { let imm=this.fetch(); let dp=this.addr_dp(); this.write(dp, eor(this.read(dp), imm)); this.cycles+=5; }); // EOR dp,#imm
        OP(0x49, function() { let s=this.fetch()|this.getDPBase(); let d=this.fetch()|this.getDPBase(); this.write(d, eor(this.read(d), this.read(s))); this.cycles+=6; }); // EOR dp,dp
        OP(0x59, function() { let x=this.X|this.getDPBase(); let y=this.Y|this.getDPBase(); this.write(x, eor(this.read(x), this.read(y))); this.cycles+=5; }); // EOR (X),(Y)
      }

      // ========================
      // Shift / Rotate
      // ========================
      const asl = (v) => { this.setFlag(1, v&0x80); let r=(v<<1)&0xFF; this.setFlags(r); return r; };
      const rol = (v) => { let c=this.PSW&1; this.setFlag(1, v&0x80); let r=((v<<1)|c)&0xFF; this.setFlags(r); return r; };
      const lsr = (v) => { this.setFlag(1, v&1); let r=v>>1; this.setFlags(r); return r; };
      const ror = (v) => { let c=this.PSW&1; this.setFlag(1, v&1); let r=(v>>1)|(c?0x80:0); this.setFlags(r); return r; };
      // ASL
      OP(0x1C, function() { this.A = asl(this.A); this.cycles+=2; });
      OP(0x0B, function() { let a=this.addr_dp(); this.write(a, asl(this.read(a))); this.cycles+=4; });
      OP(0x1B, function() { let a=this.addr_dp_x(); this.write(a, asl(this.read(a))); this.cycles+=5; });
      OP(0x0C, function() { let a=this.addr_abs(); this.write(a, asl(this.read(a))); this.cycles+=5; });
      // ROL
      OP(0x3C, function() { this.A = rol(this.A); this.cycles+=2; });
      OP(0x2B, function() { let a=this.addr_dp(); this.write(a, rol(this.read(a))); this.cycles+=4; });
      OP(0x3B, function() { let a=this.addr_dp_x(); this.write(a, rol(this.read(a))); this.cycles+=5; });
      OP(0x2C, function() { let a=this.addr_abs(); this.write(a, rol(this.read(a))); this.cycles+=5; });
      // LSR
      OP(0x5C, function() { this.A = lsr(this.A); this.cycles+=2; });
      OP(0x4B, function() { let a=this.addr_dp(); this.write(a, lsr(this.read(a))); this.cycles+=4; });
      OP(0x5B, function() { let a=this.addr_dp_x(); this.write(a, lsr(this.read(a))); this.cycles+=5; });
      OP(0x4C, function() { let a=this.addr_abs(); this.write(a, lsr(this.read(a))); this.cycles+=5; });
      // ROR
      OP(0x7C, function() { this.A = ror(this.A); this.cycles+=2; });
      OP(0x6B, function() { let a=this.addr_dp(); this.write(a, ror(this.read(a))); this.cycles+=4; });
      OP(0x7B, function() { let a=this.addr_dp_x(); this.write(a, ror(this.read(a))); this.cycles+=5; });
      OP(0x6C, function() { let a=this.addr_abs(); this.write(a, ror(this.read(a))); this.cycles+=5; });

      // ========================
      // Inc / Dec
      // ========================
      OP(0xBC, function() { this.A = (this.A + 1) & 0xFF; this.setFlags(this.A); this.cycles+=2; }); // INC A
      OP(0x3D, function() { this.X = (this.X + 1) & 0xFF; this.setFlags(this.X); this.cycles+=2; }); // INC X
      OP(0xFC, function() { this.Y = (this.Y + 1) & 0xFF; this.setFlags(this.Y); this.cycles+=2; }); // INC Y
      OP(0xAB, function() { let dp=this.addr_dp(); let v=(this.read(dp)+1)&0xFF; this.write(dp,v); this.setFlags(v); this.cycles+=4; }); // INC dp
      OP(0xBB, function() { let dp=this.addr_dp_x(); let v=(this.read(dp)+1)&0xFF; this.write(dp,v); this.setFlags(v); this.cycles+=5; }); // INC dp+X
      OP(0xAC, function() { let a=this.addr_abs(); let v=(this.read(a)+1)&0xFF; this.write(a,v); this.setFlags(v); this.cycles+=5; }); // INC abs
      OP(0x9C, function() { this.A = (this.A - 1) & 0xFF; this.setFlags(this.A); this.cycles+=2; }); // DEC A
      OP(0x1D, function() { this.X = (this.X - 1) & 0xFF; this.setFlags(this.X); this.cycles+=2; }); // DEC X
      OP(0xDC, function() { this.Y = (this.Y - 1) & 0xFF; this.setFlags(this.Y); this.cycles+=2; }); // DEC Y
      OP(0x8B, function() { let dp=this.addr_dp(); let v=(this.read(dp)-1)&0xFF; this.write(dp,v); this.setFlags(v); this.cycles+=4; }); // DEC dp
      OP(0x9B, function() { let dp=this.addr_dp_x(); let v=(this.read(dp)-1)&0xFF; this.write(dp,v); this.setFlags(v); this.cycles+=5; }); // DEC dp+X
      OP(0x8C, function() { let a=this.addr_abs(); let v=(this.read(a)-1)&0xFF; this.write(a,v); this.setFlags(v); this.cycles+=5; }); // DEC abs

      // ========================
      // MUL / DIV
      // ========================
      OP(0xCF, function() { let r=this.Y*this.A; this.A=r&0xFF; this.Y=(r>>8)&0xFF; this.setFlags(this.Y); this.cycles+=9; }); // MUL YA
      OP(0x9E, function() { // DIV YA,X (SPC700 overflow algorithm)
          const ya = ((this.Y << 8) | this.A) & 0xFFFF;
          const x = this.X & 0xFF;

          // SPC700 sets H and V from nibble/byte compares before the divide.
          this.setFlag(0x08, (this.Y & 0x0F) >= (x & 0x0F));
          this.setFlag(0x40, this.Y >= x);

          if (this.Y < ((x << 1) & 0x1FF)) {
              // Normal quotient/remainder path.
              this.A = Math.floor(ya / (x || 0x100)) & 0xFF;
              this.Y = (ya % (x || 0x100)) & 0xFF;
          } else {
              // Hardware overflow path (used by many sound drivers).
              const delta = (ya - (x << 9)) & 0x1FFFF;
              const denom = (0x100 - x) & 0xFF;
              const safeDenom = denom === 0 ? 0x100 : denom;
              this.A = (0xFF - Math.floor(delta / safeDenom)) & 0xFF;
              this.Y = (x + (delta % safeDenom)) & 0xFF;
          }

          this.setFlags(this.A);
          this.cycles+=12;
      });

      // ========================
      // Branches
      // ========================
      OP(0x2F, function() { branch(true); }); // BRA
      OP(0xF0, function() { branch((this.PSW & 0x02) !== 0); }); // BEQ (Z=1)
      OP(0xD0, function() { branch((this.PSW & 0x02) === 0); }); // BNE (Z=0)
      OP(0xB0, function() { branch((this.PSW & 0x01) !== 0); }); // BCS (C=1)
      OP(0x90, function() { branch((this.PSW & 0x01) === 0); }); // BCC (C=0)
      OP(0x70, function() { branch((this.PSW & 0x40) !== 0); }); // BVS (V=1)
      OP(0x50, function() { branch((this.PSW & 0x40) === 0); }); // BVC (V=0)
      OP(0x30, function() { branch((this.PSW & 0x80) !== 0); }); // BMI (N=1)
      OP(0x10, function() { branch((this.PSW & 0x80) === 0); }); // BPL (N=0)
      // CBNE
      OP(0x2E, function() { let dp=this.addr_dp(); let rel=this.fetch(); if(rel>127)rel-=256; if(this.A!==this.read(dp)){this.PC=(this.PC+rel)&0xFFFF;this.cycles+=7;}else{this.cycles+=5;} }); // CBNE dp,rel
      OP(0xDE, function() { let dp=this.addr_dp_x(); let rel=this.fetch(); if(rel>127)rel-=256; if(this.A!==this.read(dp)){this.PC=(this.PC+rel)&0xFFFF;this.cycles+=8;}else{this.cycles+=6;} }); // CBNE dp+X,rel
      // DBNZ
      OP(0x6E, function() { let dp=this.addr_dp(); let rel=this.fetch(); if(rel>127)rel-=256; let v=(this.read(dp)-1)&0xFF; this.write(dp,v); if(v!==0){this.PC=(this.PC+rel)&0xFFFF;this.cycles+=7;}else{this.cycles+=5;} }); // DBNZ dp,rel
      OP(0xFE, function() { let rel=this.fetch(); if(rel>127)rel-=256; this.Y=(this.Y-1)&0xFF; if(this.Y!==0){this.PC=(this.PC+rel)&0xFFFF;this.cycles+=6;}else{this.cycles+=4;} }); // DBNZ Y,rel

      // ========================
      // Bit branches: BBS / BBC (all 8 bits)
      // ========================
      for (let b = 0; b < 8; b++) {
          const bit = 1 << b;
          OP(0x03 | (b * 0x20), function() { let dp = this.addr_dp(); let rel = this.fetch(); if (rel > 127) rel -= 256; if (this.read(dp) & bit) { this.PC = (this.PC + rel) & 0xFFFF; this.cycles += 7; } else { this.cycles += 5; } }); // BBS b
          OP(0x13 | (b * 0x20), function() { let dp = this.addr_dp(); let rel = this.fetch(); if (rel > 127) rel -= 256; if (!(this.read(dp) & bit)) { this.PC = (this.PC + rel) & 0xFFFF; this.cycles += 7; } else { this.cycles += 5; } }); // BBC b
      }

      // ========================
      // Bit SET1 / CLR1 (all 8 bits)
      // ========================
      for (let b = 0; b < 8; b++) {
          const bit = 1 << b;
          OP(0x02 | (b * 0x20), function() { let dp = this.addr_dp(); this.write(dp, this.read(dp) | bit); this.cycles += 4; }); // SET1 b
          OP(0x12 | (b * 0x20), function() { let dp = this.addr_dp(); this.write(dp, this.read(dp) & ~bit); this.cycles += 4; }); // CLR1 b
      }

      // ========================
      // TSET1 / TCLR1
      // ========================
      OP(0x0E, function() { let abs=this.addr_abs(); let v=this.read(abs); this.setFlags(this.A-v); this.write(abs, v | this.A); this.cycles+=6; }); // TSET1 abs
      OP(0x4E, function() { let abs=this.addr_abs(); let v=this.read(abs); this.setFlags(this.A-v); this.write(abs, v & ~this.A); this.cycles+=6; }); // TCLR1 abs

      // ========================
      // Push / Pop
      // ========================
      OP(0x2D, function() { this.push(this.A); this.cycles+=4; }); // PUSH A
      OP(0x4D, function() { this.push(this.X); this.cycles+=4; }); // PUSH X
      OP(0x6D, function() { this.push(this.Y); this.cycles+=4; }); // PUSH Y
      OP(0x0D, function() { this.push(this.PSW); this.cycles+=4; }); // PUSH PSW
      OP(0xAE, function() { this.A = this.pop(); this.cycles+=4; }); // POP A
      OP(0xCE, function() { this.X = this.pop(); this.cycles+=4; }); // POP X
      OP(0xEE, function() { this.Y = this.pop(); this.cycles+=4; }); // POP Y
      OP(0x8E, function() { this.PSW = this.pop(); this.cycles+=4; }); // POP PSW

      // ========================
      // Subroutines / Jumps
      // ========================
      OP(0x3F, function() { let addr=this.fetch16(); this.push16(this.PC); this.PC=addr; this.cycles+=8; }); // CALL abs
      OP(0x4F, function() { let off=this.fetch(); this.push16(this.PC); this.PC=0xFF00|off; this.cycles+=6; }); // PCALL u8
      OP(0x5F, function() { this.PC=this.fetch16(); this.cycles+=3; }); // JMP abs
      OP(0x1F, function() { let addr=this.fetch16(); let lo=this.read((addr+this.X)&0xFFFF); let hi=this.read((addr+this.X+1)&0xFFFF); this.PC=(hi<<8)|lo; this.cycles+=6; }); // JMP [abs+X]
      OP(0x6F, function() { this.PC=this.pop16(); this.cycles+=5; }); // RET
      OP(0x7F, function() { this.PSW=this.pop(); this.PC=this.pop16(); this.cycles+=6; }); // RETI

      // ========================
      // TCALL (Table Call) - 16 vectors at $FFDE down to $FFC0
      // ========================
      for (let n = 0; n < 16; n++) {
          const vecAddr = 0xFFDE - (n * 2);
          OP(0x01 | (n << 4), function() { this.push16(this.PC); this.PC = this.read(vecAddr) | (this.read(vecAddr + 1) << 8); this.cycles += 8; });
      }

      // ========================
      // Flag operations
      // ========================
      OP(0x60, function() { this.PSW &= ~0x01; this.cycles+=2; }); // CLRC
      OP(0x80, function() { this.PSW |= 0x01; this.cycles+=2; });  // SETC
      OP(0xED, function() { this.PSW ^= 0x01; this.cycles+=3; });  // NOTC
      OP(0xE0, function() { this.PSW &= ~(0x40 | 0x08); this.cycles+=2; }); // CLRV (clear V and H flags)
      OP(0x20, function() { this.PSW &= ~0x20; this.cycles+=2; }); // CLRP
      OP(0x40, function() { this.PSW |= 0x20; this.cycles+=2; });  // SETP
      OP(0xA0, function() { this.PSW |= 0x04; this.cycles+=3; });  // EI
      OP(0xC0, function() { this.PSW &= ~0x04; this.cycles+=3; }); // DI

      // ========================
      // Misc
      // ========================
      OP(0x00, function() { this.cycles+=2; }); // NOP
      OP(0xEF, function() { this.PC=(this.PC-1)&0xFFFF; this.cycles+=3; }); // SLEEP (loop in place)
      OP(0xFF, function() { this.PC=(this.PC-1)&0xFFFF; this.cycles+=3; }); // STOP (loop in place)
      OP(0x9F, function() { this.A = ((this.A >> 4) | ((this.A & 0x0F) << 4)) & 0xFF; this.setFlags(this.A); this.cycles+=5; }); // XCN (exchange nibbles)
      OP(0xDF, function() { // DAA
          let a = this.A;
          if (((this.PSW & 0x08) !== 0) || (a & 0x0F) > 9) { a += 6; }
          if (((this.PSW & 0x01) !== 0) || a > 0x9F) { a += 0x60; this.PSW |= 0x01; }
          this.A = a & 0xFF; this.setFlags(this.A); this.cycles += 3;
      });
      OP(0xBE, function() { // DAS
          let a = this.A;
          if (!((this.PSW & 0x08) !== 0) || (a & 0x0F) > 9) { a -= 6; }
          if (!((this.PSW & 0x01) !== 0) || a > 0x9F) { a -= 0x60; this.PSW &= ~0x01; }
          this.A = a & 0xFF; this.setFlags(this.A); this.cycles += 3;
      });

      // ========================
      // Bit manipulation (memory bit operations)
      // ========================
      // MOV1 C, mem.bit  (0xAA)
      OP(0xAA, function() { let abs=this.fetch16(); let bit=(abs>>13)&7; abs&=0x1FFF; this.setFlag(1, (this.read(abs)>>bit)&1); this.cycles+=4; });
      // MOV1 mem.bit, C  (0xCA)
      OP(0xCA, function() { let abs=this.fetch16(); let bit=(abs>>13)&7; abs&=0x1FFF; let v=this.read(abs); if(this.PSW&1) v|=(1<<bit); else v&=~(1<<bit); this.write(abs,v); this.cycles+=6; });
      // OR1 C, mem.bit   (0x0A)
      OP(0x0A, function() { let abs=this.fetch16(); let bit=(abs>>13)&7; abs&=0x1FFF; if((this.read(abs)>>bit)&1) this.PSW|=1; this.cycles+=5; });
      // OR1 C, /mem.bit  (0x2A)
      OP(0x2A, function() { let abs=this.fetch16(); let bit=(abs>>13)&7; abs&=0x1FFF; if(!((this.read(abs)>>bit)&1)) this.PSW|=1; this.cycles+=5; });
      // AND1 C, mem.bit  (0x4A)
      OP(0x4A, function() { let abs=this.fetch16(); let bit=(abs>>13)&7; abs&=0x1FFF; if(!((this.read(abs)>>bit)&1)) this.PSW&=~1; this.cycles+=4; });
      // AND1 C, /mem.bit (0x6A)
      OP(0x6A, function() { let abs=this.fetch16(); let bit=(abs>>13)&7; abs&=0x1FFF; if((this.read(abs)>>bit)&1) this.PSW&=~1; this.cycles+=4; });
      // EOR1 C, mem.bit  (0x8A)
      OP(0x8A, function() { let abs=this.fetch16(); let bit=(abs>>13)&7; abs&=0x1FFF; if((this.read(abs)>>bit)&1) this.PSW^=1; this.cycles+=5; });
      // NOT1 mem.bit     (0xEA)
      OP(0xEA, function() { let abs=this.fetch16(); let bit=(abs>>13)&7; abs&=0x1FFF; this.write(abs, this.read(abs)^(1<<bit)); this.cycles+=5; });

  }
}

exports.APU = APU;

};

registry['MMU'] = function(module,exports,require) {
const DSP1 = require('./DSP1').DSP1;

class MMU {
  constructor() {
        this.wram = new Uint8Array(128 * 1024); // 128KB WRAM
    this.sram = new Uint8Array(128 * 1024); // 128KB SRAM
    this.rom = null;
    this.ppu = null;
    this.apu = null;

    // DSP-1 math coprocessor (Super Mario Kart, Pilotwings, etc.)
    this.hasDSP1 = false;
    this.dsp1 = null;

    // DMA Channels (0-7)
    this.dma = [];
    for (let i = 0; i < 8; i++) {
        this.dma[i] = {
            dmap: 0, // Control
            bbad: 0, // Dest ($21xx)
            a1t: 0,  // Src Addr (16-bit)
            a1b: 0,  // Src Bank
            das: 0,  // Size / Indirect Bank
            dasb: 0, // Indirect Addr (HDMA)
            a2a: 0,  // Line Counter (HDMA)
            ntrl: 0, // Unknown / HDMA related

            // HDMA runtime state
            tableAddress: 0,
            tableBank: 0,
            indirectAddress: 0,
            repeat: false,
            doTransfer: false,
            completed: false,
            repeatData: new Array(4).fill(0) // pre-loaded data for REPEAT direct entries
        };
    }
    this.mdmaen = 0; // DMA Enable
    this.hdmaen = 0; // HDMA Enable
    this.nmitimen = 0;
    this.rdnmi = 0;

    // WRAM Access Registers ($2180 - $2183)
    this.wmaddl = 0; // 16-bit
    this.wmaddh = 0; // 1-bit (17-bit total address)

    // Joypads
    this.joy1 = 0;
    this.joy2 = 0;
    this.joy1Str = 0;
    this.joy2Str = 0;
    this.joyStrobe = 0;

    // Auto Joypad Read registers
    this.autoJoy = new Uint8Array(8); // 4218-421F

    // Hardware Math Registers ($4202 - $4206, $4214 - $4217)
    this.multiplicand = 0; // $4202
    this.multiplier = 0;   // $4203
    this.dividend = 0;     // $4204, $4205
    this.divisor = 0;      // $4206
    this.quotient = 0;     // $4214, $4215
    this.product = 0;      // $4216, $4217 (also used for remainder)

    // IRQ Timer Registers
    this.vtime = 0; // Vertical IRQ Timer
    this.htime = 0; // Horizontal IRQ Timer
    this.timeUp = false; // IRQ Flag ($4211.7)
  }

  connectPPU(ppu) {
    this.ppu = ppu;
  }

  connectAPU(apu) {
    this.apu = apu;
  }

  loadRom(buffer) {
    console.log(`[ROM-BUF] buffer.length=${buffer.length} buffer.constructor.name=${buffer.constructor.name}`);
    let data = new Uint8Array(buffer);
    if (data.length % 1024 === 512) {
        console.log("SMC Header detected, stripping...");
        data = data.slice(512);
    }
    console.log(`[ROM-POST] data.length=0x${data.length.toString(16)} data[0x2766D]=0x${(data[0x2766D] || 0).toString(16)} data[0]=0x${data[0].toString(16)}`);
    this.rom = data;
    console.log(`ROM loaded, size: ` + this.rom.length);
    // Debug: check byte before and after slice
    console.log(`[ROM-CHECK] data.length=${data.length} data[0x200]=0x${data[0x200].toString(16)} data[0]=0x${data[0].toString(16)}`);
    console.log(`[ROM-CHECK] rom[0x2766D]=0x${(this.rom[0x2766D] || 0).toString(16)} (expected 0x80 if header stripped correctly)`);



    // Improved LoROM vs HiROM Detection
    let loScore = 0;
    let hiScore = 0;

    // Check LoROM header at $007FC0
    if (this.rom.length >= 0x8000) {
        const title = this.rom.slice(0x7FC0, 0x7FC0 + 21);
        loScore += this.checkHeader(title);
        // Map mode byte at $7FD5: bit0=0 → LoROM
        const mapMode = this.rom[0x7FD5];
        if ((mapMode & 0x0F) === 0x00) loScore += 5; // LoROM indicator
    }

    // Check HiROM header at $00FFC0
    if (this.rom.length >= 0x10000) {
        const title = this.rom.slice(0xFFC0, 0xFFC0 + 21);
        hiScore += this.checkHeader(title);
        // Map mode byte at $FFD5: bit0=1 → HiROM
        const mapMode = this.rom[0xFFD5];
        if ((mapMode & 0x0F) === 0x01) hiScore += 5; // HiROM indicator
    }

    // Improve Detection with Vector Analysis
    // LoROM Vectors: 0x7FE0-0x7FFF
    // HiROM Vectors: 0xFFE0-0xFFFF

    const countValidVectors = (base) => {
        let count = 0;
        // Check NMI (base+10), Reset (base+12), IRQ (base+14)
        for (let i = 4; i < 16; i+=2) {
             const addr = base + i;
             if (addr + 1 >= this.rom.length) continue;
             const vec = this.rom[addr] | (this.rom[addr+1] << 8);
             if (vec > 0x8000 && vec < 0xFFFF) count++;
        }
        return count;
    };

    // Check LoROM
    const loVecScore = (this.rom.length >= 0x8000) ? countValidVectors(0x7FE0) : 0;
    // Check HiROM
    const hiVecScore = (this.rom.length >= 0x10000) ? countValidVectors(0xFFE0) : 0;

    if (loVecScore > hiVecScore) {
        loScore += 10;
    } else if (hiVecScore > loVecScore) {
        hiScore += 10;
    }

    // Prefer LoROM if scores are close or undetermined
    this.isHiRom = (hiScore > loScore);
    console.log(`Mapper detection: ${this.isHiRom ? "HiROM" : "LoROM"} (Lo:${loScore} Hi:${hiScore}) [VecScores: ${loVecScore}/${hiVecScore}]`);

    // DSP-1 coprocessor detection (cart type byte at header+0x16)
    const headerBase = this.isHiRom ? 0xFFC0 : 0x7FC0;
    if (this.rom.length > headerBase + 0x16) {
        const cartType = this.rom[headerBase + 0x16];
        // 0x03 = ROM+DSP, 0x05 = ROM+RAM+Battery+DSP (Super Mario Kart, Pilotwings, ...)
        this.hasDSP1 = (cartType === 0x03 || cartType === 0x05);
        if (this.hasDSP1) {
            this.dsp1 = new DSP1();
            console.log(`[MMU] DSP-1 coprocessor enabled (cartType=0x${cartType.toString(16)})`);
        }
    }

    // Debug: Check Vectors
    setTimeout(() => {
        const readWord = (addr) => {
            const lo = this.read(addr);
            const hi = this.read((addr + 1) & 0xFFFF); // Wrap in bank 0
            return (hi << 8) | lo;
        };

        const nNMI = readWord(0xFFEA);
        const nIRQ = readWord(0xFFEE);
        const eReset = readWord(0xFFFC);
        const eIRQ = readWord(0xFFFE);

        console.log(`[MMU] Vectors: Native [NMI:${nNMI.toString(16)} IRQ:${nIRQ.toString(16)}] Emu [Reset:${eReset.toString(16)} IRQ:${eIRQ.toString(16)}]`);
    }, 100);
  }

  checkHeader(bytes) {
      if (!bytes) return 0;
      let score = 0;
      for (let i = 0; i < bytes.length; i++) {
          const c = bytes[i];
          if (c >= 0x20 && c <= 0x7E) score++; // Printable ASCII
      }
      return score;
  }

  read(addr) {
    const bank = (addr >> 16) & 0xFF;
    const offset = addr & 0xFFFF;

    // Direct Page / WRAM Mirror (00-3F:0000-1FFF) and (80-BF:0000-1FFF)
    // Applies to both LoROM and HiROM
    if ((bank <= 0x3F || (bank >= 0x80 && bank <= 0xBF)) && offset <= 0x1FFF) {
      return this.wram[offset];
    }

    // WRAM (7E-7F) Full access
    if (bank >= 0x7E && bank <= 0x7F) {
        const wramAddr = ((bank & 1) << 16) | offset;
        return this.wram[wramAddr];
    }

    // SRAM
    if (!this.isHiRom) {
        // LoROM SRAM: 70-7D (and F0-FD), 0000-7FFF
        if (((bank >= 0x70 && bank <= 0x7D) || (bank >= 0xF0 && bank <= 0xFD)) && offset <= 0x7FFF) {
             const sramBank = (bank & 0x0F) * 0x8000;
             return this.sram[(sramBank + offset) % this.sram.length];
        }
    } else {
        // HiROM SRAM: 20-3F (and A0-BF), 6000-7FFF
        if (((bank >= 0x20 && bank <= 0x3F) || (bank >= 0xA0 && bank <= 0xBF)) && offset >= 0x6000 && offset <= 0x7FFF) {
             const sramBank = (bank & 0x1F) * 0x2000;
             return this.sram[(sramBank + (offset - 0x6000)) % this.sram.length];
        }
    }

    // DSP-1 coprocessor registers: banks 00-1F/80-9F, DR @ $6000-$6FFF, SR @ $7000-$7FFF
    if (this.hasDSP1 && ((bank & 0xE0) === 0x00 || (bank & 0xE0) === 0x80) && offset >= 0x6000 && offset <= 0x7FFF) {
        if (offset < 0x7000) {
            return this.dsp1.getByte();
        }
        return 0x80; // SR: Rqm/ready always set
    }

    if (this.rom) {
        let romAddr = -1;

        // LoROM Mapping
        if (!this.isHiRom) {
            // Banks 00-7D & 80-FD: 8000-FFFF is ROM
            // (Ignoring 00-3F 0000-7FFF special mappings for now)
            if ((bank & 0x7F) <= 0x7D && offset >= 0x8000) {
                // Map: (Bank & 0x7F) * 32KB + (Offset - 0x8000)
                // Note: Bank 00->00000, 01->08000, 02->10000...
                // Actually Bank / 2 * 64K + Remainder?
                // Standard LoROM:
                // Bank 00: 0000-7FFF (Sys), 8000-FFFF (Rom 00000-07FFF)
                // Bank 01: 0000-7FFF (Sys), 8000-FFFF (Rom 08000-0FFFF)
                romAddr = (((bank & 0x7F) << 15) | (offset & 0x7FFF)) % this.rom.length;
            }
        }
        // HiROM Mapping
        else {
            // HiROM: Linear map in C0-FF.
            // C0: 0000-FFFF -> Rom 000000-00FFFF
            if (bank >= 0xC0) {
                 romAddr = ((bank & 0x3F) << 16) | offset;
            } else if (bank >= 0x80 && offset >= 0x8000) {
                 // Mirror of C0-FF upper half
                 romAddr = ((bank & 0x3F) << 16) | offset;
            } else if (bank < 0x40 && offset >= 0x8000) {
                 // Mirror of C0-FF upper half
                 romAddr = ((bank & 0x3F) << 16) | offset;
            } else if (bank >= 0x40 && bank <= 0x7D) {
                 // Usually ROM linear?
                 romAddr = ((bank & 0x3F) << 16) | offset;
            }
        }

        if (romAddr !== -1 && romAddr < this.rom.length) {
            // Debug: log bank4 $F66D read
            if (bank === 4 && offset === 0xF66D && !globalThis._b4f66d_logged) {
                globalThis._b4f66d_logged = true;
                console.log(`[ROM-DBG] bank4:F66D romAddr=0x${romAddr.toString(16)} rom[romAddr]=0x${this.rom[romAddr].toString(16).padStart(2,'0')} romLen=0x${this.rom.length.toString(16)}`);
            }
            return this.rom[romAddr];
        }
    }


    // PPU Reigsters / System Area
    // Mirrors: 00-3F and 80-BF
    // Addresses 2000-5FFF are system I/O (PPU, APU, DMA, Registers)

    // Check if address is in System Area
    // Condition: Bank is 00-3F or 80-BF AND Offset is 2000-5FFF
    if ((bank & 0x40) === 0 && offset >= 0x2000 && offset <= 0x5FFF) {
        // PPU Registers ($2100-$213F)
        if (offset >= 0x2100 && offset <= 0x213F) {
            return this.ppu ? this.ppu.read(offset) : 0;
        }

        // APU Communication ($2140-$217F, mirrored every 4 bytes)
        if (offset >= 0x2140 && offset <= 0x217F) {
            let val = this.apu ? this.apu.readCPU(offset & 3) : 0;
            return val;
        }

        // WRAM Data Read ($2180)
        if (offset === 0x2180) {
            // Read from WRAM at WMADD and increment address
            const wmAddr = (this.wmaddh & 1) * 0x10000 + this.wmaddl;
            const wmVal = this.wram[wmAddr & 0x1FFFF];
            const wmNext = (wmAddr + 1) & 0x1FFFF;
            this.wmaddl = wmNext & 0xFFFF;
            this.wmaddh = (wmNext >> 16) & 1;
            return wmVal;
        }

        // Joypad / IO ($4000-$4017)
        // Joypad Read ($4016/$4017)
        if (offset === 0x4016) {
           const bit = (this.joy1Str >> 15) & 1;
           if (!this.joyStrobe) {
             this.joy1Str = (this.joy1Str << 1) | 1;
           }
           return bit | 0x40;
        }
        if (offset === 0x4017) {
           const bit = (this.joy2Str >> 15) & 1;
           if (!this.joyStrobe) {
             this.joy2Str = (this.joy2Str << 1) | 1;
           }
           return bit | 0x40;
        }

        // Interrupt / DMA Enables ($4200-$420D)
        if (offset === 0x4200) return this.nmitimen; // Usually not readable

        // $4210 Reads NMI status
        if (offset === 0x4210) {
            const val = (this.rdnmi & 0x80) | 0x02;
            this.rdnmi &= 0x7F;
            return val;
        }

        // TIMEUP ($4211)
        if (offset === 0x4211) {
            const val = (this.timeUp ? 0x80 : 0);
            this.timeUp = false;
            if (this.apu && this.apu.irqPending) {
                 // Clear APU irq line? Usually unrelated.
            }
            // Clear CPU IRQ line (usually happens automatically?
            // Actually, if using level interrupts, clearing the source clears the line.
            // My CPU implementation clears line on taking interrupt.
            // But if interrupt wasn't taken yet (masked by I), clearing this stops it from firing later.
            // So we should signal CPU.
            // However, direct access is tricky. Let's rely on CPU polling checkInterrupts()
            return val;
        }

        // HVBJOY ($4212)
        if (offset === 0x4212) {
             if (this.ppu && this.ppu.hvbjoy) return this.ppu.hvbjoy;
             return 0;
        }

        // Math Registers Read ($4214 - $4217)
        if (offset === 0x4214) return this.quotient & 0xFF; // Quotient L
        if (offset === 0x4215) return (this.quotient >> 8) & 0xFF; // Quotient H
        if (offset === 0x4216) return this.product & 0xFF; // Product/Remainder L
        if (offset === 0x4217) return (this.product >> 8) & 0xFF; // Product/Remainder H

        // Auto Joypad Read ($4218-$421F)
        if (offset >= 0x4218 && offset <= 0x421F) {
            return this.autoJoy[offset - 0x4218];
        }

        // DMA Registers ($4300-$437F)
        if (offset >= 0x4300 && offset <= 0x437F) {
            const channel = (offset >> 4) & 0x7;
            const reg = offset & 0xF;
            const d = this.dma[channel];
            switch (reg) {
                case 0: return d.dmap;
                case 1: return d.bbad;
                case 2: return d.a1t & 0xFF;
                case 3: return (d.a1t >> 8) & 0xFF;
                case 4: return d.a1b;
                case 5: return d.das & 0xFF;
                case 6: return (d.das >> 8) & 0xFF;
                default: return 0xFF;
            }
        }
    }

    return 0; // Open bus
  }

  write(addr, value) {
    const bank = (addr >> 16) & 0xFF;
    const offset = addr & 0xFFFF;

    // Track $9B writes for debugging — disabled (too noisy)
    // if ((bank <= 0x3F && offset === 0x9B) || (bank === 0x7E && offset === 0x9B)) { ... }

    // Direct Page / WRAM Mirror (00-3F:0000-1FFF) and (80-BF:0000-1FFF)
    if ((bank <= 0x3F || (bank >= 0x80 && bank <= 0xBF)) && offset <= 0x1FFF) {
        // Watch $0DAE (brightness), $0100 (game state), $0D9F (HDMAEN source)
        if (globalThis._dmaLog && (offset === 0x0DAE || offset === 0x0100 || offset === 0x0D9F)) {
            const cpuRef = globalThis._snesCPU;
            const pc = cpuRef ? `${cpuRef.PB.toString(16).padStart(2,'0')}:${cpuRef.PC.toString(16).padStart(4,'0')}` : '??:????';
            const fr = globalThis._snesFrame || 0;
            console.log(`[WRAM] $${offset.toString(16).padStart(4,'0')} = 0x${value.toString(16).padStart(2,'0')} frame=${fr} PC=${pc}`);
        }
        if (globalThis._dmaLog && (offset === 0x141D || offset === 0x141A)) {
            const cpuRef = globalThis._snesCPU;
            const oppc = cpuRef ? `${(cpuRef._opPB||0).toString(16).padStart(2,'0')}:${(cpuRef._opPC||0).toString(16).padStart(4,'0')}` : '??:????';
            const fr = globalThis._snesFrame || 0;
            console.log(`[WRAM-141x] $${offset.toString(16).padStart(4,'0')} = 0x${value.toString(16).padStart(2,'0')} fr=${fr} opPC=${oppc}`);
        }

        // Watch full palette buffer area $0700-$070F for first 300 frames
        if (offset >= 0x0700 && offset <= 0x070F) {
            const _cpuPal = globalThis._snesCPU;
            const _pc = _cpuPal ? `${(_cpuPal._opPB||0).toString(16).padStart(2,'0')}:${(_cpuPal._opPC||0).toString(16).padStart(4,'0')}` : '??:????';
            const _fr = globalThis._snesFrame || 0;
            const _a = _cpuPal ? _cpuPal.A : -1;
            if (globalThis._dmaLog && _fr <= 350) console.log(`[PAL-BUF] $${offset.toString(16).padStart(4,'0')}=0x${value.toString(16).padStart(2,'0')} A=0x${_a.toString(16)} fr=${_fr} opPC=${_pc}`);
        }
        if (false && globalThis._dmaLog && (offset === 0x0703 || offset === 0x0704)) {
            const cpuRef4 = globalThis._snesCPU;
            const pc4 = cpuRef4 ? `${cpuRef4.PB.toString(16).padStart(2,'0')}:${cpuRef4.PC.toString(16).padStart(4,'0')}` : '??:????';
            const oppc4 = cpuRef4 ? `${(cpuRef4._opPB||0).toString(16).padStart(2,'0')}:${(cpuRef4._opPC||0).toString(16).padStart(4,'0')}` : '??:????';
            const a4 = cpuRef4 ? cpuRef4.A : -1;
            const fr4 = globalThis._snesFrame || 0;
            console.log(`[WRAM-PAL0] $${offset.toString(16).padStart(4,'0')} = 0x${value.toString(16).padStart(2,'0')} A=0x${a4.toString(16)} frame=${fr4} nextPC=${pc4} opPC=${oppc4}`);
        }
        // Watch window HDMA data area 0x04A0..0x04FF
        if (globalThis._dmaLog && offset >= 0x04A0 && offset <= 0x04FF) {
            const cpuRef = globalThis._snesCPU;
            const pc = cpuRef ? `${cpuRef.PB.toString(16).padStart(2,'0')}:${cpuRef.PC.toString(16).padStart(4,'0')}` : '??:????';
            const fr = globalThis._snesFrame || 0;
            if (fr >= 280 && fr <= 320 && value !== 0) {
                console.log(`[WRAM-WIN] $${offset.toString(16).padStart(4,'0')} = 0x${value.toString(16).padStart(2,'0')} frame=${fr} PC=${pc}`);
            }
        }

        if (globalThis._wramWatch && (offset === 0x187A || offset === 0x18E7 || offset === 0x72 || offset === 0x1471 || offset === 0x18DF)) {
            const _cpuW = globalThis._snesCPU;
            const _pcW = _cpuW ? `${_cpuW.PB.toString(16).padStart(2,'0')}:${_cpuW.PC.toString(16).padStart(4,'0')}` : '?';
            const _frW = globalThis._snesFrame || 0;
            console.log(`[WWATCH] $${offset.toString(16).padStart(4,'0')}=${value.toString(16)} fr=${_frW} @${_pcW}`);
        }
        if (globalThis._dp72Watch && offset === 0x0072) {
            const _cpuZ = globalThis._snesCPU;
            const _opPcZ = _cpuZ ? `${(_cpuZ._opPB||_cpuZ.PB).toString(16).padStart(2,'0')}:${(_cpuZ._opPC||_cpuZ.PC).toString(16).padStart(4,'0')}` : '?';
            process.stderr.write(`[DP72] $0072=${value.toString(16).padStart(2,'0')} opPC=${_opPcZ}\n`);
        }
        if (globalThis._dp77Watch && offset === 0x0077) {
            const _cpuY = globalThis._snesCPU;
            const _opPcY = _cpuY ? `${(_cpuY._opPB||_cpuY.PB).toString(16).padStart(2,'0')}:${(_cpuY._opPC||_cpuY.PC).toString(16).padStart(4,'0')}` : '?';
            process.stderr.write(`[DP77] $0077=${value.toString(16).padStart(2,'0')} opPC=${_opPcY}\n`);
        }
        if (globalThis._dp15Watch && offset === 0x0015) {
            const _cpuD = globalThis._snesCPU;
            const _opPcD = _cpuD ? `${(_cpuD._opPB||_cpuD.PB).toString(16).padStart(2,'0')}:${(_cpuD._opPC||_cpuD.PC).toString(16).padStart(4,'0')}` : '?';
            const _frD = globalThis._snesFrame || 0;
            const _dD = _cpuD ? _cpuD.DP : -1;
            process.stderr.write(`[DP15] $0015=${value.toString(16).padStart(2,'0')} fr=${_frD} opPC=${_opPcD} D=${_dD.toString(16)}\n`);
        }
        // watch writes to $13BF (overworld position)
        if (globalThis._watch13BF && offset === 0x13BF) {
            const _cpu13 = globalThis._snesCPU;
            const _pc13 = _cpu13 ? `${_cpu13.PB.toString(16).padStart(2,'0')}:${_cpu13.PC.toString(16).padStart(4,'0')}` : '?';
            const _op13 = _cpu13 ? `${(_cpu13._opPB||_cpu13.PB).toString(16).padStart(2,'0')}:${(_cpu13._opPC||_cpu13.PC).toString(16).padStart(4,'0')}` : '?';
            const _fr13 = globalThis._snesFrame || 0;
            process.stderr.write(`[13BF] $13BF=${value.toString(16).padStart(2,'0')} fr=${_fr13} nextPC=${_pc13} opPC=${_op13}\n`);
        }
        // forceNav: prevent NMI from clearing $18DF (simulates Mario overworld sprite being active)
        // NMI at bank1:$80A4 does STZ $18DF; after exec, cpu.PC = $80A7, cpu.PB = 1
        if (globalThis._forceNav && offset === 0x18DF && value === 0) {
            const _cpu = globalThis._snesCPU;
            if (_cpu && _cpu.PB === 1 && _cpu.PC === 0x80A7) {
                this.wram[0x18DF] = 1; // keep $18DF=1 so NMI protects $187A
                return;
            }
        }
        // navHook: when the walk-step signal (dp$72) fires non-zero, update $13BF
        // via the bank5:$D847 destination-node formula, using current path-table data.
        if (globalThis._navHook && offset === 0x0072 && value !== 0) {
            const _hook = globalThis._navHook;
            globalThis._navHook = null; // fire only once per walk
            _hook.call(this);
        }
        this.wram[offset] = value;
        return;
    }
    // WRAM (7E-7F) Full access
    if (bank >= 0x7E && bank <= 0x7F) {
        const wramAddr = ((bank & 1) << 16) | offset;
        if (false && (wramAddr === 0x0703 || wramAddr === 0x0704)) {
            const cpuRef3 = globalThis._snesCPU;
            const pc3 = cpuRef3 ? `${cpuRef3.PB.toString(16).padStart(2,'0')}:${cpuRef3.PC.toString(16).padStart(4,'0')}` : '??:????';
            const oppc3 = cpuRef3 ? `${(cpuRef3._opPB||0).toString(16).padStart(2,'0')}:${(cpuRef3._opPC||0).toString(16).padStart(4,'0')}` : '??:????';
            const a3 = cpuRef3 ? cpuRef3.A : -1;
            const fr3 = globalThis._snesFrame || 0;
            console.log(`[WRAM-PAL0] $${wramAddr.toString(16).padStart(4,'0')} = 0x${value.toString(16).padStart(2,'0')} A=0x${a3.toString(16)} frame=${fr3} nextPC=${pc3} opPC=${oppc3}`);
        }
        // Watch palette buffer area $0700-$070F (7E bank)
        if (wramAddr >= 0x0700 && wramAddr <= 0x070F) {
            const _cpuPal2 = globalThis._snesCPU;
            const _pc2 = _cpuPal2 ? `${(_cpuPal2._opPB||0).toString(16).padStart(2,'0')}:${(_cpuPal2._opPC||0).toString(16).padStart(4,'0')}` : '??:????';
            const _fr2 = globalThis._snesFrame || 0;
            const _a2 = _cpuPal2 ? _cpuPal2.A : -1;
            if (globalThis._dmaLog && _fr2 <= 350) console.log(`[PAL-BUF] $${wramAddr.toString(16).padStart(4,'0')}=0x${value.toString(16).padStart(2,'0')} A=0x${_a2.toString(16)} fr=${_fr2} opPC=${_pc2}`);
        }
        if (wramAddr === 0x0DAE || wramAddr === 0x0100) {
            const cpuRef = globalThis._snesCPU;
            const pc = cpuRef ? `${cpuRef.PB.toString(16).padStart(2,'0')}:${cpuRef.PC.toString(16).padStart(4,'0')}` : '??:????';
            const fr = globalThis._snesFrame || 0;
            console.log(`[WRAM] $${wramAddr.toString(16).padStart(4,'0')} = 0x${value.toString(16).padStart(2,'0')} frame=${fr} PC=${pc}`);
        }
        if (wramAddr === 0x141D || wramAddr === 0x141A) {
            const cpuRef = globalThis._snesCPU;
            const oppc = cpuRef ? `${(cpuRef._opPB||0).toString(16).padStart(2,'0')}:${(cpuRef._opPC||0).toString(16).padStart(4,'0')}` : '??:????';
            const fr = globalThis._snesFrame || 0;
            console.log(`[WRAM-141x] $${wramAddr.toString(16).padStart(4,'0')} = 0x${value.toString(16).padStart(2,'0')} fr=${fr} opPC=${oppc}`);
        }

        if (globalThis._wramWatch && (wramAddr === 0x187A || wramAddr === 0x18E7 || wramAddr === 0x72 || wramAddr === 0x1471 || wramAddr === 0x18DF)) {
            const _cpuW2 = globalThis._snesCPU;
            const _pcW2 = _cpuW2 ? `${_cpuW2.PB.toString(16)}:${_cpuW2.PC.toString(16).padStart(4,'0')}` : '?';
            const _frW2 = globalThis._snesFrame || 0;
            console.log(`[WWATCH] $${wramAddr.toString(16).padStart(4,'0')}=${value.toString(16)} fr=${_frW2} @${_pcW2}`);
        }
        this.wram[wramAddr] = value;
        // Optional Chrono-specific debug mirror (disabled by default).
        if (globalThis._ctMirror7fTo7e && (bank & 1) === 1 && offset >= 0x7200 && offset <= 0xBFFF) {
            this.wram[offset] = value;
        }
        return;
    }

    // SRAM Write
    if (!this.isHiRom) {
        // LoROM SRAM
        if (((bank >= 0x70 && bank <= 0x7D) || (bank >= 0xF0 && bank <= 0xFD)) && offset <= 0x7FFF) {
             const sramBank = (bank & 0x0F) * 0x8000;
             this.sram[(sramBank + offset) % this.sram.length] = value;
             return;
        }
    } else {
        // HiROM SRAM
        if (((bank >= 0x20 && bank <= 0x3F) || (bank >= 0xA0 && bank <= 0xBF)) && offset >= 0x6000 && offset <= 0x7FFF) {
             const sramBank = (bank & 0x1F) * 0x2000;
             this.sram[(sramBank + (offset - 0x6000)) % this.sram.length] = value;
             return;
        }
    }

    // DSP-1 coprocessor registers: banks 00-1F/80-9F, DR @ $6000-$6FFF, SR @ $7000-$7FFF (read-only)
    if (this.hasDSP1 && ((bank & 0xE0) === 0x00 || (bank & 0xE0) === 0x80) && offset >= 0x6000 && offset <= 0x7FFF) {
        if (offset < 0x7000) {
            this.dsp1.setByte(value);
        }
        return;
    }

    // System Area Write (2000-5FFF in Banks 00-3F & 80-BF)
    if ((bank & 0x40) === 0 && offset >= 0x2000 && offset <= 0x5FFF) {

        // PPU Registers
        if (offset >= 0x2100 && offset <= 0x213F) {
            if (this.ppu) this.ppu.write(offset, value);
            return;
        }

        // APU Communication ($2140-$217F, mirrored every 4 bytes)
        if (offset >= 0x2140 && offset <= 0x217F) {
            if (this.apu) this.apu.writeCPU(offset & 3, value);
            return;
        }

        // WRAM Access ($2180-$2183)
        if (offset === 0x2180) {
            // WMDATA: Write to WRAM and increment address
            const addr = (this.wmaddh & 1) * 0x10000 + this.wmaddl; // 17-bit address
            if (globalThis._wramWatch && (addr === 0x187A || addr === 0x18DF || addr === 0x18E7)) {
                const _cpuWM = globalThis._snesCPU;
                const _pcWM = _cpuWM ? `${_cpuWM.PB.toString(16)}:${_cpuWM.PC.toString(16).padStart(4,'0')}` : '?';
                const _frWM = globalThis._snesFrame || 0;
                console.log(`[WWATCH-WM] $${addr.toString(16).padStart(4,'0')}=${value.toString(16)} fr=${_frWM} @${_pcWM}`);
            }
            this.wram[addr & 0x1FFFF] = value;
            // Optional Chrono-specific debug mirror (disabled by default).
            if (globalThis._ctMirror7fTo7e && this.wmaddh === 1 && this.wmaddl >= 0x7200 && this.wmaddl <= 0xBFFF) {
                this.wram[this.wmaddl] = value;
            }

            // Increment logic (usually 17-bit wrap? SNES wraps at 128KB? or 0000-FFFF?)
            // WRAM is 128KB (0-1FFFF).
            // Increment is usually 17-bit.
            const next = (addr + 1) & 0x1FFFF;
            this.wmaddl = next & 0xFFFF;
            this.wmaddh = (next >> 16) & 1;
            return;
        }
        if (offset === 0x2181) { this.wmaddl = (this.wmaddl & 0xFF00) | value; return; }
        if (offset === 0x2182) { this.wmaddl = (this.wmaddl & 0x00FF) | (value << 8); return; }
        if (offset === 0x2183) { this.wmaddh = value & 1; return; }


        // OLD JOYPAD PORTS ($4016)
        if (offset === 0x4016) {
             const strobe = value & 1;
             if (this.joyStrobe === 1 && strobe === 0) {
                 this.joy1Str = this.joy1;
                 this.joy2Str = this.joy2;
             }
             this.joyStrobe = strobe;
             return;
        }

        // Interrupt / NMI Enable ($4200)
        if (offset === 0x4200) {
            if (globalThis._dmaLog && value !== this.nmitimen) {
                const cpu = globalThis._snesCPU;
                const pcStr = cpu ? `${cpu.PB.toString(16).padStart(2,'0')}:${cpu.PC.toString(16).padStart(4,'0')}` : '??:????';
                console.log(`[MMU] $4200 NMITIMEN: ${this.nmitimen.toString(16)} -> ${value.toString(16)} (NMI: ${(value & 0x80) ? 'ON' : 'OFF'}) PC=${pcStr}`);
                if (value === 0) {
                    console.trace('[MMU] NMITIMEN set to 0 - call stack');
                }
            }
            this.nmitimen = value;
            return;
        }

        // H/V Timer ($4207-$420A)
        if (offset === 0x4207) { this.htime = (this.htime & 0xFF00) | value; return; }
        if (offset === 0x4208) { this.htime = (this.htime & 0x00FF) | ((value & 1) << 8); return; }
        if (offset === 0x4209) { this.vtime = (this.vtime & 0xFF00) | value; return; }
        if (offset === 0x420A) { this.vtime = (this.vtime & 0x00FF) | ((value & 1) << 8); return; }

        // Math Registers Write ($4202 - $4206)
        if (offset === 0x4202) { this.multiplicand = value; return; } // Multiplicand
        if (offset === 0x4203) { // Multiplier -> Execute Multiplication
            this.multiplier = value;
            this.product = this.multiplicand * this.multiplier;
            return;
        }
        if (offset === 0x4204) { this.dividend = (this.dividend & 0xFF00) | value; return; } // Dividend L
        if (offset === 0x4205) { this.dividend = (this.dividend & 0x00FF) | (value << 8); return; } // Dividend H
        if (offset === 0x4206) { // Divisor -> Execute Division
            this.divisor = value;
            if (this.divisor === 0) {
                this.quotient = 0xFFFF; // Divide by zero
                this.product = this.dividend; // Remainder gets dividend
            } else {
                this.quotient = Math.floor(this.dividend / this.divisor) & 0xFFFF;
                this.product = (this.dividend % this.divisor) & 0xFFFF;
            }
            return;
        }

        // DMA / HDMA Enable
        if (offset === 0x420B) { // MDMAEN
            this.mdmaen = value;
            this.executeDMA();
            return;
        }
        if (offset === 0x420C) { // HDMAEN
            const _hdfr = globalThis._snesFrame || 0;
            const _hdcpu = globalThis._snesCPU;
            const _hdpc = _hdcpu ? `${(_hdcpu._opPB||0).toString(16).padStart(2,'0')}:${(_hdcpu._opPC||0).toString(16).padStart(4,'0')}` : '??:????';
            if(globalThis._dmaLog) console.log(`[HDMAEN-WRITE] frame=${_hdfr} val=0x${value.toString(16).padStart(2,'0')} opPC=${_hdpc}`);
            this.hdmaen = value;
            return;
        }

        // DMA Registers ($4300-$437F)
        if (offset >= 0x4300 && offset <= 0x437F) {
            const channel = (offset >> 4) & 0x7;
            const reg = offset & 0xF;
            const d = this.dma[channel];
            switch (reg) {
                case 0: d.dmap = value; break;
                case 1: d.bbad = value; break;
                case 2: d.a1t = (d.a1t & 0xFF00) | value; break;
                case 3: d.a1t = (d.a1t & 0x00FF) | (value << 8); break;
                case 4: d.a1b = value; break;
                case 5: d.das = (d.das & 0xFF00) | value; break;
                case 6: d.das = (d.das & 0x00FF) | (value << 8); break;
                case 7: d.dasb = value; break;
                case 8: d.a2a = (d.a2a & 0xFF00) | value; break;
                case 9: d.a2a = (d.a2a & 0x00FF) | (value << 8); break;
            }
            return;
        }
    }
  }

  executeDMA() {
      for (let i = 0; i < 8; i++) {
          if (this.mdmaen & (1 << i)) {
              this.doDMA(i);
              this.mdmaen &= ~(1 << i);
          }
      }
  }

  doDMA(ch) {
      const d = this.dma[ch];
      let srcBank = d.bbad; // Wait, bbad is dest ($21xx). a1b is src bank.
      // Re-read structure:
      // bbad: Dest ($21xx)
      // a1t: Src Addr (16-bit)
      // a1b: Src Bank

      let workSrcBank = d.a1b;
      let workSrcAddr = d.a1t;
      const destBase = 0x2100 | d.bbad;

      // Log DMA to CGRAM ($2122) to diagnose sky color
      const _dmafr = globalThis._snesFrame || 0;
      if (d.bbad === 0x22) {
          const _ppu2 = globalThis._snesPPU;
          const _cgadd = _ppu2 ? _ppu2.cgadd : -1;

          const srcBytes = [];
          for (let _k = 0; _k < Math.min(8, d.das === 0 ? 65536 : d.das); _k++) {
              srcBytes.push(this.read(((workSrcBank & 0x7F) << 16) | ((workSrcAddr + _k) & 0xFFFF)).toString(16).padStart(2,'0'));
          }
          if(globalThis._dmaLog) console.log(`[DMA-CGRAM] frame=${_dmafr} ch=${ch} cgadd=0x${_cgadd.toString(16)} src=${workSrcBank.toString(16)}:${workSrcAddr.toString(16).padStart(4,'0')} size=${d.das} mode=${d.dmap&7} first8bytes=[${srcBytes.join(' ')}] first_color=0x${(parseInt(srcBytes[1]||'00',16)<<8|parseInt(srcBytes[0]||'00',16)).toString(16).padStart(4,'0')}`);
      }
      // Log DMA to VRAM ($2118/$2119) -- watch for writes to BG3 charBase area (0x4000+)
      if (d.bbad === 0x18 || d.bbad === 0x19) {
          const _ppu = globalThis._snesPPU;
          const _vaddr = _ppu ? _ppu.vramAddr : 0;
          const srcBytes = [];
          for (let _k = 0; _k < Math.min(8, d.das === 0 ? 65536 : d.das); _k++) {
              srcBytes.push(this.read(((workSrcBank & 0x7F) << 16) | ((workSrcAddr + _k) & 0xFFFF)).toString(16).padStart(2,'0'));
          }
          if(globalThis._dmaLog) console.log(`[DMA-VRAM] frame=${_dmafr} ch=${ch} vramAddr=0x${_vaddr.toString(16)} src=${workSrcBank.toString(16)}:${workSrcAddr.toString(16).padStart(4,'0')} size=${d.das} mode=${d.dmap&7} bbad=0x${d.bbad.toString(16)} first8bytes=[${srcBytes.join(' ')}]`);
      }

      const mode = d.dmap & 0x07; // Transfer Mode
      const fixed = (d.dmap & 0x10) !== 0; // Fixed Source Address? No, Bit 4 is Fixed?
      // Bit 3: Unused / Repeat?
      // Bit 4: Decrement/Increment? Wait.
      // 7: Direction (0=A->B, 1=B->A)
      // 6: HDMA Indirect
      // 5: Unused?
      // 4: Decrement (if 1)
      // 3: Fixed (if 1)

      const direction = (d.dmap & 0x80) !== 0;
      const dec = (d.dmap & 0x10) !== 0; // Check docs: Bit 4 is Decrement (usually bit 4 is decrement A-Bus addr?)
      // Actually:
      // 7: Transfer Direction
      // 6: Addressing Mode (HDMA) / Unused (DMA)
      // 5: Unused?
      // 4: Increment/Decrement (0=Inc, 1=Dec) IF Fixed is 0
      // 3: Fixed (0=Adjust, 1=Fixed)

      // Let's re-verify bits. SNES Dev manuals:
      // Bit 7: Direction (0: CPU->PPU, 1: PPU->CPU)
      // Bit 6: HDMA Addressing (0: Direct, 1: Indirect)
      // Bit 5: Unused
      // Bit 4: A-Bus Step (0: Increment, 1: Decrement)
      // Bit 3: A-Bus Fixed (0: Not Fixed, 1: Fixed)
      // Bit 2-0: Transfer Mode

      const stepDec = (d.dmap & 0x10) !== 0;
      const stepFixed = (d.dmap & 0x08) !== 0;

      let count = d.das; // Size
      if (count === 0) count = 0x10000;

      // console.log(`DMA Ch${ch} Mode${mode} Addr ${d.a1b.toString(16)}:${d.a1t.toString(16)} -> 21${d.bbad.toString(16).padStart(2,'0')} Size ${count}`);

      // Transfer loop
      let stepBytes = 1;
      let pattern = [0];

      // console.log(`[MMU] DMA Ch${ch} Mode${mode} ${direction?'Rd':'Wr'} Addr ${workSrcBank.toString(16).padStart(2,'0')}:${workSrcAddr.toString(16).padStart(4,'0')} -> 21${d.bbad.toString(16).padStart(2,'0')} Size ${count}`);

      switch(mode) {
          case 0: pattern = [0]; break;
          case 1: pattern = [0, 1]; break;
          case 2: pattern = [0, 0]; break;
          case 3: pattern = [0, 0, 1, 1]; break;
          case 4: pattern = [0, 1, 2, 3]; break;
          case 5: pattern = [0, 1, 0, 1]; break;
          default: pattern = [0]; break; // Fallback
      }

      let pIdx = 0;

      while (count > 0) {
          if (!direction) { // Mem (A) -> PPU (B)
             // Read byte from A-Bus
             const val = this.read((workSrcBank << 16) | workSrcAddr);

             // Write to PPU B-Bus
             // Calculate Dest Register based on pattern
             const offset = pattern[pIdx];
             this.write(destBase + offset, val);

             pIdx = (pIdx + 1) % pattern.length;
          } else { // PPU (B) -> Mem (A)
             // Read byte from B-Bus
             const bOffset = pattern[pIdx];
             const val = this.read(destBase + bOffset);

             // Write to A-Bus (WRAM or other)
             this.write((workSrcBank << 16) | workSrcAddr, val);

             pIdx = (pIdx + 1) % pattern.length;
          }

          if (!stepFixed) {
              if (!stepDec) workSrcAddr = (workSrcAddr + 1) & 0xFFFF;
              else workSrcAddr = (workSrcAddr - 1) & 0xFFFF;
          }

          count--;
      }

      d.das = 0; // Register update (becomes 0 after transfer)
      d.a1t = workSrcAddr; // Address updates
  }

  initHDMA() {
      const fr = globalThis._snesFrame || 0;
      if (fr === 340) {
          console.log(`[HDMA] frame=${fr} hdmaen=0x${this.hdmaen.toString(16)}`);
          for (let i = 0; i < 8; i++) {
              if (this.hdmaen & (1 << i)) {
                  const d = this.dma[i];
                  const indirect = (d.dmap >> 6) & 1;
                  let indir_ptr = 0;
                  if (indirect) {
                      const tmpAddr = d.a1t + 1; // after lineCount byte
                      const lo = this.read((d.a1b << 16) | tmpAddr);
                      const hi = this.read((d.a1b << 16) | (tmpAddr + 1));
                      indir_ptr = (hi << 8) | lo;
                  }
                  console.log(`[HDMA] ch${i} bbad=0x${d.bbad.toString(16)} dmap=0x${d.dmap.toString(16)} mode=${d.dmap&7} indirect=${indirect} a1t=0x${d.a1t.toString(16)} a1b=0x${d.a1b.toString(16)} dasb=0x${d.dasb.toString(16)} das=0x${d.das.toString(16)} indir_ptr=0x${indir_ptr.toString(16)}`);
                  if (indirect) {
                      // Print first few data bytes of indirect table
                      const bytes = [];
                      for (let j = 0; j < 8; j++) bytes.push(this.read((d.dasb << 16) | ((indir_ptr + j) & 0xFFFF)).toString(16).padStart(2,'0'));
                      console.log(`[HDMA] ch${i} indirect data @0x${d.dasb.toString(16)}:${indir_ptr.toString(16)}: ${bytes.join(' ')}`);
                  }
              }
          }
      }
      for (let i = 0; i < 8; i++) {
          if (this.hdmaen & (1 << i)) {
              const d = this.dma[i];
              d.tableAddress = d.a1t;
              d.tableBank = d.a1b;

              d.a2a = this.read((d.tableBank << 16) | d.tableAddress);
              d.tableAddress++;

              d.repeat = (d.a2a & 0x80) !== 0;
              d.a2a &= 0x7F;
              d.completed = (d.a2a === 0);

              const indirect = (d.dmap >> 6) & 1;
              if (indirect === 1 && !d.completed) {
                  const lo = this.read((d.tableBank << 16) | d.tableAddress);
                  d.tableAddress++;
                  const hi = this.read((d.tableBank << 16) | d.tableAddress);
                  d.tableAddress++;
                  d.indirectAddress = (hi << 8) | lo;
              } else if (indirect === 0 && d.repeat && !d.completed) {
                  const nBytes = [1,2,2,4,4,4,2,4][(d.dmap & 7)] || 1;
                  for (let b = 0; b < nBytes; b++) {
                      d.repeatData[b] = this.read((d.tableBank << 16) | d.tableAddress);
                      d.tableAddress++;
                  }
              }
              d.doTransfer = true;
          }
      }
  }

  doHDMA() {
      const _hfr2 = globalThis._snesFrame || 0;
      const _hline2 = globalThis._snesScanline || 0;
      if (_hfr2 === 340 && _hline2 === 0) {
          console.log(`[HDMA-STATE] fr=${_hfr2} hdmaen=0x${this.hdmaen.toString(16)}`);
          for (let _j = 0; _j < 8; _j++) {
              if (this.hdmaen & (1 << _j)) {
                  const _d = this.dma[_j];
                  console.log(`  ch${_j}: bbad=0x${_d.bbad.toString(16)} dmap=0x${_d.dmap.toString(16)} mode=${_d.dmap&7} indirect=${(_d.dmap>>6)&1} completed=${_d.completed} doTransfer=${_d.doTransfer} a2a=${_d.a2a} tableBank=0x${_d.tableBank.toString(16)} tableAddr=0x${_d.tableAddress.toString(16)}`);
              }
          }
      }
      for (let i = 0; i < 8; i++) {
          if (this.hdmaen & (1 << i)) {
              const d = this.dma[i];
              if (d.completed) continue;

              const mode = d.dmap & 7;
              const indirect = (d.dmap >> 6) & 1;

              if (d.doTransfer) {
                  let pattern;
                  switch(mode) {
                      case 0: pattern = [0]; break;
                      case 1: pattern = [0, 1]; break;
                      case 2: pattern = [0, 0]; break;
                      case 3: pattern = [0, 0, 1, 1]; break;
                      case 4: pattern = [0, 1, 2, 3]; break;
                      case 5: pattern = [0, 1, 0, 1]; break;
                      default: pattern = [0]; break;
                  }

                  const destBase = 0x2100 | d.bbad;
                  const _hfr = globalThis._snesFrame || 0;
                  const _hline = globalThis._snesScanline || 0;
                  // Log all HDMA writes at fr=340 lines 0-5
                  const _logHdmaAll = _hfr === 340 && _hline <= 5;
                  const _logHdmaCg = d.bbad === 0x22 && _hfr >= 330 && _hfr <= 345 && (_hline <= 5 || (_hline >= 50 && _hline <= 55));
                  let byteIdx = 0;
                  for (let pOffset of pattern) {
                      let val;
                      if (indirect === 0) {
                          if (d.repeat) {
                              val = d.repeatData[byteIdx];
                          } else {
                              val = this.read((d.tableBank << 16) | d.tableAddress);
                              d.tableAddress++;
                          }
                      } else {
                          val = this.read((d.dasb << 16) | d.indirectAddress);
                          d.indirectAddress++;
                      }
                      byteIdx++;
                      if (_logHdmaAll) console.log(`[HDMA-ALL] fr=${_hfr} line=${_hline} ch=${i} bbad=0x${d.bbad.toString(16)} pOffset=${pOffset} val=0x${val.toString(16).padStart(2,'0')}`);
                      if (_logHdmaCg) console.log(`[HDMA-CG] fr=${_hfr} line=${_hline} ch=${i} pOffset=${pOffset} val=0x${val.toString(16).padStart(2,'0')}`);
                      this.write(destBase + pOffset, val);
                  }
              }

              d.a2a--;

              if (d.a2a === 0) {
                  d.a2a = this.read((d.tableBank << 16) | d.tableAddress);
                  d.tableAddress++;

                  d.repeat = (d.a2a & 0x80) !== 0;
                  d.a2a &= 0x7F;
                  if (d.a2a === 0) {
                      d.completed = true;
                  } else {
                      if (indirect === 1) {
                          const lo = this.read((d.tableBank << 16) | d.tableAddress);
                          d.tableAddress++;
                          const hi = this.read((d.tableBank << 16) | d.tableAddress);
                          d.tableAddress++;
                          d.indirectAddress = (hi << 8) | lo;
                      } else if (d.repeat) {
                          const nBytes = [1,2,2,4,4,4,2,4][mode] || 1;
                          for (let b = 0; b < nBytes; b++) {
                              d.repeatData[b] = this.read((d.tableBank << 16) | d.tableAddress);
                              d.tableAddress++;
                          }
                      }
                      d.doTransfer = true;
                  }
              } else {
                  d.doTransfer = d.repeat;
              }
          }
      }
  }

  readWord(addr) {
    const lo = this.read(addr);
    const hi = this.read((addr + 1) & 0xFFFFFF); // Auto-wrap? simplified
    return (hi << 8) | lo;
  }

  writeWord(addr, value) {
    this.write(addr, value & 0xFF);
    this.write((addr + 1) & 0xFFFFFF, (value >> 8) & 0xFF);
  }
}

exports.MMU = MMU;

};

registry['DSP'] = function(module,exports,require) {
// SNES DSP Implementation
// Based on exact hardware definitions (Gaussian interpolation, ADSR, BRR, Echo, FIR, PMON, NON)

class DSP {
    constructor() {
        this.ram = new Uint8Array(128);
        this.apu_ram = null;

        this.sampleBufferL = new Float32Array(8192);
        this.sampleBufferR = new Float32Array(8192);
        this.samplePos = 0;

        this.outL = 0;
        this.outR = 0;

        this.voices = [];
        for (let i = 0; i < 8; i++) {
            this.voices.push(new Voice());
        }

        this.mvolL = 0; this.mvolR = 0;
        this.evolL = 0; this.evolR = 0;
        this.kon = 0; this.kout = 0;
        this.flg = 0xE0;
        this.endx = 0;
        this.efb = 0;
        this.pmon = 0;
        this.non = 0;
        this.eon = 0;
        this.dir = 0;
        this.esa = 0;
        this.edl = 0;
        this.fir = new Int32Array(8);

        this.echoPointer = 0;
        this.echoLength = 0;
        this.echoBuf = new Int32Array(16); // 8 taps × 2 (L+R)
        this.echoPtr = 0;

        this.noiseCounter = 0;
        this.noiseVal = 0x4000;
        this.noiseRate = 0;

        this.counter = 0;

        // Exact hardware Gaussian table (512 entries; both halves of the
        // table are indexed during 4-tap interpolation, so a shorter table
        // causes out-of-bounds/undefined lookups at low fractional positions).
        this.gauss = new Int32Array([
            0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000,
            0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000,
            0x001, 0x001, 0x001, 0x001, 0x001, 0x001, 0x001, 0x001,
            0x001, 0x001, 0x001, 0x002, 0x002, 0x002, 0x002, 0x002,
            0x002, 0x002, 0x003, 0x003, 0x003, 0x003, 0x003, 0x004,
            0x004, 0x004, 0x004, 0x004, 0x005, 0x005, 0x005, 0x005,
            0x006, 0x006, 0x006, 0x006, 0x007, 0x007, 0x007, 0x008,
            0x008, 0x008, 0x009, 0x009, 0x009, 0x00A, 0x00A, 0x00A,
            0x00B, 0x00B, 0x00B, 0x00C, 0x00C, 0x00D, 0x00D, 0x00E,
            0x00E, 0x00F, 0x00F, 0x00F, 0x010, 0x010, 0x011, 0x011,
            0x012, 0x013, 0x013, 0x014, 0x014, 0x015, 0x015, 0x016,
            0x017, 0x017, 0x018, 0x018, 0x019, 0x01A, 0x01B, 0x01B,
            0x01C, 0x01D, 0x01D, 0x01E, 0x01F, 0x020, 0x020, 0x021,
            0x022, 0x023, 0x024, 0x024, 0x025, 0x026, 0x027, 0x028,
            0x029, 0x02A, 0x02B, 0x02C, 0x02D, 0x02E, 0x02F, 0x030,
            0x031, 0x032, 0x033, 0x034, 0x035, 0x036, 0x037, 0x038,
            0x03A, 0x03B, 0x03C, 0x03D, 0x03E, 0x040, 0x041, 0x042,
            0x043, 0x045, 0x046, 0x047, 0x049, 0x04A, 0x04C, 0x04D,
            0x04E, 0x050, 0x051, 0x053, 0x054, 0x056, 0x057, 0x059,
            0x05A, 0x05C, 0x05E, 0x05F, 0x061, 0x063, 0x064, 0x066,
            0x068, 0x06A, 0x06B, 0x06D, 0x06F, 0x071, 0x073, 0x075,
            0x076, 0x078, 0x07A, 0x07C, 0x07E, 0x080, 0x082, 0x084,
            0x086, 0x089, 0x08B, 0x08D, 0x08F, 0x091, 0x093, 0x096,
            0x098, 0x09A, 0x09C, 0x09F, 0x0A1, 0x0A3, 0x0A6, 0x0A8,
            0x0AB, 0x0AD, 0x0AF, 0x0B2, 0x0B4, 0x0B7, 0x0BA, 0x0BC,
            0x0BF, 0x0C1, 0x0C4, 0x0C7, 0x0C9, 0x0CC, 0x0CF, 0x0D2,
            0x0D4, 0x0D7, 0x0DA, 0x0DD, 0x0E0, 0x0E3, 0x0E6, 0x0E9,
            0x0EC, 0x0EF, 0x0F2, 0x0F5, 0x0F8, 0x0FB, 0x0FE, 0x101,
            0x104, 0x107, 0x10B, 0x10E, 0x111, 0x114, 0x118, 0x11B,
            0x11E, 0x122, 0x125, 0x129, 0x12C, 0x130, 0x133, 0x137,
            0x13A, 0x13E, 0x141, 0x145, 0x148, 0x14C, 0x150, 0x153,
            0x157, 0x15B, 0x15F, 0x162, 0x166, 0x16A, 0x16E, 0x172,
            0x176, 0x17A, 0x17D, 0x181, 0x185, 0x189, 0x18D, 0x191,
            0x195, 0x19A, 0x19E, 0x1A2, 0x1A6, 0x1AA, 0x1AE, 0x1B2,
            0x1B7, 0x1BB, 0x1BF, 0x1C3, 0x1C8, 0x1CC, 0x1D0, 0x1D5,
            0x1D9, 0x1DD, 0x1E2, 0x1E6, 0x1EB, 0x1EF, 0x1F3, 0x1F8,
            0x1FC, 0x201, 0x205, 0x20A, 0x20F, 0x213, 0x218, 0x21C,
            0x221, 0x226, 0x22A, 0x22F, 0x233, 0x238, 0x23D, 0x241,
            0x246, 0x24B, 0x250, 0x254, 0x259, 0x25E, 0x263, 0x267,
            0x26C, 0x271, 0x276, 0x27B, 0x280, 0x284, 0x289, 0x28E,
            0x293, 0x298, 0x29D, 0x2A2, 0x2A6, 0x2AB, 0x2B0, 0x2B5,
            0x2BA, 0x2BF, 0x2C4, 0x2C9, 0x2CE, 0x2D3, 0x2D8, 0x2DC,
            0x2E1, 0x2E6, 0x2EB, 0x2F0, 0x2F5, 0x2FA, 0x2FF, 0x304,
            0x309, 0x30E, 0x313, 0x318, 0x31D, 0x322, 0x326, 0x32B,
            0x330, 0x335, 0x33A, 0x33F, 0x344, 0x349, 0x34E, 0x353,
            0x357, 0x35C, 0x361, 0x366, 0x36B, 0x370, 0x374, 0x379,
            0x37E, 0x383, 0x388, 0x38C, 0x391, 0x396, 0x39B, 0x39F,
            0x3A4, 0x3A9, 0x3AD, 0x3B2, 0x3B7, 0x3BB, 0x3C0, 0x3C5,
            0x3C9, 0x3CE, 0x3D2, 0x3D7, 0x3DC, 0x3E0, 0x3E5, 0x3E9,
            0x3ED, 0x3F2, 0x3F6, 0x3FB, 0x3FF, 0x403, 0x408, 0x40C,
            0x410, 0x415, 0x419, 0x41D, 0x421, 0x425, 0x42A, 0x42E,
            0x432, 0x436, 0x43A, 0x43E, 0x442, 0x446, 0x44A, 0x44E,
            0x452, 0x455, 0x459, 0x45D, 0x461, 0x465, 0x468, 0x46C,
            0x470, 0x473, 0x477, 0x47A, 0x47E, 0x481, 0x485, 0x488,
            0x48C, 0x48F, 0x492, 0x496, 0x499, 0x49C, 0x49F, 0x4A2,
            0x4A6, 0x4A9, 0x4AC, 0x4AF, 0x4B2, 0x4B5, 0x4B7, 0x4BA,
            0x4BD, 0x4C0, 0x4C3, 0x4C5, 0x4C8, 0x4CB, 0x4CD, 0x4D0,
            0x4D2, 0x4D5, 0x4D7, 0x4D9, 0x4DC, 0x4DE, 0x4E0, 0x4E3,
            0x4E5, 0x4E7, 0x4E9, 0x4EB, 0x4ED, 0x4EF, 0x4F1, 0x4F3,
            0x4F5, 0x4F6, 0x4F8, 0x4FA, 0x4FB, 0x4FD, 0x4FF, 0x500,
            0x502, 0x503, 0x504, 0x506, 0x507, 0x508, 0x50A, 0x50B,
            0x50C, 0x50D, 0x50E, 0x50F, 0x510, 0x511, 0x511, 0x512,
            0x513, 0x514, 0x514, 0x515, 0x516, 0x516, 0x517, 0x517,
            0x517, 0x518, 0x518, 0x518, 0x518, 0x518, 0x519, 0x519,
        ]);
    }

    reset() {
        this.ram.fill(0);
        this.flg = 0xE0;
        this.samplePos = 0;
        this.counter = 0;
        for (let i = 0; i < 8; i++) {
            this.voices[i].reset();
        }
    }

    setApuRam(ram) {
        this.apu_ram = ram;
    }

    read(addr) {
        addr &= 0x7F;
        const voiceIdx = Math.floor(addr / 16);
        const reg = addr % 16;
        if (voiceIdx < 8 && reg < 0x0A) {
            if (reg === 0x08) return this.voices[voiceIdx].envx >> 4;
            if (reg === 0x09) return this.voices[voiceIdx].outx >> 4;
        }
        if (addr === 0x7C) return this.endx;
        return this.ram[addr];
    }

    write(addr, val) {
        // Detailed logging for KON/KEY-OFF/VOL
        if (globalThis._dmaLog && addr === 0x4C) {
            console.log(`[DSP] KON write: value=0x${val.toString(16)}`);
        }
        if (globalThis._dmaLog && addr === 0x5C) {
            console.log(`[DSP] KEYOFF write: value=0x${val.toString(16)}`);
        }
        if (globalThis._dmaLog && ((addr >= 0x0C && addr <= 0x0D) || (addr >= 0x1C && addr <= 0x1D) || (addr >= 0x2C && addr <= 0x2D) || (addr >= 0x3C && addr <= 0x3D))) {
            console.log(`[DSP] VOL write: addr=0x${addr.toString(16)} value=0x${val.toString(16)}`);
        }
        // Structured write recorder (enable by setting this.recordWrites = [] before run).
        if (this.recordWrites) {
            this.recordWrites.push([this.samplePos | 0, addr & 0x7F, val & 0xFF]);
        }
        addr &= 0x7F;
        this.ram[addr] = val;

        const voiceIdx = Math.floor(addr / 16);
        const reg = addr % 16;

        if (voiceIdx < 8 && reg < 0x0A) {
            const v = this.voices[voiceIdx];
            switch (reg) {
                case 0x00: v.volL = (val << 24) >> 24; break;
                case 0x01: v.volR = (val << 24) >> 24; break;
                case 0x02: v.pitch = (v.pitch & 0xFF00) | val; break;
                case 0x03: v.pitch = (v.pitch & 0x00FF) | ((val & 0x3F) << 8); break;
                case 0x04: v.srcn = val; break;
                case 0x05: v.adcr = (v.adcr & 0xFF00) | val; break;
                case 0x06: v.adcr = (v.adcr & 0x00FF) | (val << 8); break;
                case 0x07: v.gain = val; break;
            }
        } else {
            switch (addr) {
                case 0x0C: this.mvolL = (val << 24) >> 24; break;
                case 0x1C: this.mvolR = (val << 24) >> 24; break;
                case 0x2C: this.evolL = (val << 24) >> 24; break;
                case 0x3C: this.evolR = (val << 24) >> 24; break;
                case 0x4C:
                    this.kon = val;
                    for (let i = 0; i < 8; i++) {
                        if (val & (1 << i)) {
                            const v = this.voices[i];
                            v.state = 'ATTACK';
                            v.envx = 0;
                            v.envCounter = 0;
                            v.decodeIdx = 16;
                            v.s1 = 0; v.s2 = 0;
                            v.history.fill(0);
                            v.pitchCounter = 0;
                            const dirOffset = (this.dir << 8) + (v.srcn * 4);
                            v.decodeOffset = (this.apu_ram[dirOffset+1] << 8) | this.apu_ram[dirOffset];
                            v.brrLoopPtr = (this.apu_ram[dirOffset+3] << 8) | this.apu_ram[dirOffset+2];
                        }
                    }
                    break;
                case 0x5C:
                    this.kout = val;
                    for (let i = 0; i < 8; i++) {
                        if (val & (1 << i)) {
                            if (this.voices[i].state !== 'STOP') {
                                this.voices[i].state = 'RELEASE';
                            }
                        }
                    }
                    break;
                case 0x6C:
                    this.flg = val;
                    this.noiseRate = val & 0x1F;
                    break;
                case 0x7C: this.endx = 0; break;
                case 0x0D: this.efb = (val << 24) >> 24; break;
                case 0x2D: this.pmon = val; break;
                case 0x3D: this.non = val; break;
                case 0x4D: this.eon = val; break;
                case 0x5D: this.dir = val; break;
                case 0x6D: this.esa = val; break;
                case 0x7D:
                    this.edl = val & 0x0F;
                    // Each EDL unit = 2KB (0x800 bytes) of APU RAM = 16ms of echo delay.
                    // echoLength is in 4-byte stereo sample-pairs, so 2048/4 = 512 per EDL unit.
                    this.echoLength = this.edl > 0 ? this.edl * 512 : 1;
                    break;
                case 0x0F: case 0x1F: case 0x2F: case 0x3F:
                case 0x4F: case 0x5F: case 0x6F: case 0x7F:
                    this.fir[addr >> 4] = (val << 24) >> 24; break;
            }
        }
    }

    decodeBRR(v) {
        const addr = v.decodeOffset;
        if (addr >= 0xFFFF) return;
        const header = this.apu_ram[addr];
        const shift = (header >> 4) & 0x0F;
        const filter = (header >> 2) & 0x03;

        let s1 = v.s1;
        let s2 = v.s2;

        let outIdx = 0;
        for (let i = 0; i < 8; i++) {
            const b = this.apu_ram[(addr + 1 + i) & 0xFFFF];
            for (let nibble = 0; nibble < 2; nibble++) {
                let n = (nibble === 0) ? (b >> 4) : (b & 0x0F);
                if (n >= 8) n -= 16;

                // BRR raw sample (anomie S-DSP doc):
                //   shift <= 12:  sample = (n << shift) >> 1
                //   shift >  12:  positive nibble -> 0, negative -> 0xF800 (-2048)
                // Values are in 15-bit signed range here.
                let sample;
                if (shift <= 12) sample = (n << shift) >> 1;
                else sample = (n < 0) ? -2048 : 0;

                if (filter === 1) sample += s1 + ((-s1) >> 4);
                else if (filter === 2) sample += s1 * 2 + ((-s1 * 3) >> 5) - s2 + (s2 >> 4);
                else if (filter === 3) sample += s1 * 2 + ((-s1 * 13) >> 6) - s2 + ((s2 * 3) >> 4);

                // Anomie S-DSP doc: the filter accumulator is computed in
                // higher precision, then clipped to the full 16-bit signed
                // range (32767 >= S >= -32768, no wrapping) — NOT to 15 bits.
                if (sample > 32767) sample = 32767;
                else if (sample < -32768) sample = -32768;

                v.decoded[outIdx++] = sample;
                s2 = s1;
                s1 = sample;
            }
        }
        v.s1 = s1;
        v.s2 = s2;

        const isEnd = header & 1;
        const isLoop = header & 2;
        if (isEnd) {
            this.endx |= (1 << this.voices.indexOf(v));
            if (isLoop) {
                v.decodeOffset = v.brrLoopPtr;
            } else {
                v.state = 'STOP';
            }
        } else {
            v.decodeOffset = (v.decodeOffset + 9) & 0xFFFF;
        }
    }

    step() {
        if (this.flg & 0x80) {
            if (this.samplePos < this.sampleBufferL.length) {
                this.sampleBufferL[this.samplePos] = 0;
                this.sampleBufferR[this.samplePos++] = 0;
            }
            return;
        }

        this.counter++;

        // Noise Generation
        // noiseRate 0 = never update; use same rate table as envelopes
        if (this.noiseRate > 0) {
            const noisePeriod = Voice.envRatePeriod(this.noiseRate);
            if (noisePeriod > 0 && (this.counter % noisePeriod) === 0) {
                // 15-bit LFSR: feedback bit = bit0 XOR bit1, shifted into bit14 (Anomie S-DSP doc)
                const parity = (this.noiseVal ^ (this.noiseVal >> 1)) & 1;
                this.noiseVal = ((this.noiseVal >> 1) | (parity << 14)) & 0x7FFF;
            }
        }

        let mOutL = 0;
        let mOutR = 0;
        let eOutL = 0;
        let eOutR = 0;

        let pmon_pitch = 0;

        for (let i = 0; i < 8; i++) {
            const v = this.voices[i];

            if (v.state === 'STOP') {
                v.envx = 0;
                v.outx = 0;
                pmon_pitch = v.outx;
                continue;
            }

            // Envelope step
            v.stepEnvelope();

            let pitch = v.pitch;
            if (i > 0 && (this.pmon & (1 << i))) {
                // S-DSP pitch modulation (anomie):
                //   factor = prev_voice_outx >> 5  (signed, ~-1024..+1023)
                //   pitch  = pitch + ((pitch * factor) >> 10)
                // PMON for voice 0 has no effect (no previous voice).
                const factor = pmon_pitch >> 5;
                pitch = pitch + ((pitch * factor) >> 10);
            }
            if (pitch > 0x3FFF) pitch = 0x3FFF;
            if (pitch < 0) pitch = 0;

            v.pitchCounter += pitch;
            while (v.pitchCounter >= 0x1000) {
                v.pitchCounter -= 0x1000;
                if (v.state === 'STOP') break;
                if (v.decodeIdx >= 16) {
                    this.decodeBRR(v);
                    v.decodeIdx = 0;
                }

                let s = v.decoded[v.decodeIdx];
                v.history[v.historyIdx] = s;
                v.historyIdx = (v.historyIdx + 1) & 3;
                v.decodeIdx++;
            }

            let s0 = v.history[(v.historyIdx - 4) & 3];
            let s1 = v.history[(v.historyIdx - 3) & 3];
            let s2 = v.history[(v.historyIdx - 2) & 3];
            let s3 = v.history[(v.historyIdx - 1) & 3];

            let fract = v.pitchCounter >> 4;

            let out1 = (s0 * this.gauss[0x0FF - fract]) >> 11;
            let out2 = (s1 * this.gauss[0x1FF - fract]) >> 11;
            let out3 = (s2 * this.gauss[0x100 + fract]) >> 11;
            let out4 = (s3 * this.gauss[0x000 + fract]) >> 11;

            let out = out1 + out2 + out3 + out4;
            if (out > 32767) out = 32767;
            else if (out < -32768) out = -32768;

            if (this.non & (1 << i)) {
                // Treat LFSR output as signed 15-bit (bit 14 = sign bit)
                out = this.noiseVal >= 0x4000 ? this.noiseVal - 0x8000 : this.noiseVal;
            }

            out = (out * v.envx) >> 15;
            v.outx = out;
            pmon_pitch = out;

            // Hardware signal flow (Anomie S-DSP doc, step G): after the
            // per-voice volume multiply, the sample is left-shifted by 1 —
            // this restores the LSB that BRR decoding loses (the doc notes
            // the lost low bit "is recovered after the VxVOLL/VxVOLR volume
            // adjustment").
            let l = ((out * v.volL) >> 7) << 1;
            let r = ((out * v.volR) >> 7) << 1;

            mOutL += l;
            mOutR += r;

            if (this.eon & (1 << i)) {
                eOutL += l;
                eOutR += r;
            }
        }

        // Master output & Mute
        if (!(this.flg & 0x40)) {
            mOutL = (mOutL * this.mvolL) >> 7;
            mOutR = (mOutR * this.mvolR) >> 7;
        } else {
            mOutL = 0;
            mOutR = 0;
        }

        // Echo logic (stubbed FIR for brevity, valid echo path)
        const echoLen = this.echoLength > 0 ? this.echoLength : 1;
        if (this.echoPointer >= echoLen * 4) this.echoPointer = 0;
        let echoAddr = (this.esa << 8) + this.echoPointer;
        let eHL = 0, eHR = 0;
        if (!(this.flg & 0x20)) { // Echo enable checking
            let eL = this.apu_ram[echoAddr & 0xFFFF] | (this.apu_ram[(echoAddr + 1) & 0xFFFF] << 8);
            let eR = this.apu_ram[(echoAddr + 2) & 0xFFFF] | (this.apu_ram[(echoAddr + 3) & 0xFFFF] << 8);
            if (eL & 0x8000) eL |= 0xFFFF0000;
            if (eR & 0x8000) eR |= 0xFFFF0000;

            this.echoBuf[this.echoPtr] = eL;
            this.echoBuf[this.echoPtr + 1] = eR;
            this.echoPtr = (this.echoPtr + 2) & 15;

            // Apply 8-tap FIR filter to echo read-back (Anomie S-DSP doc):
            //   FIR = S(x)*FIR0 + S(x-1)*FIR1 + ... + S(x-7)*FIR7
            // S(x) is the newest echo sample (just written at echoPtr-2),
            // so FIR[0] weights the newest and FIR[7] the oldest.
            let firL = 0, firR = 0;
            for (let fi = 0; fi < 8; fi++) {
                const idx = (this.echoPtr - 2 - (fi * 2)) & 15;
                firL += (this.echoBuf[idx] * this.fir[fi]) >> 6;
                firR += (this.echoBuf[idx + 1] * this.fir[fi]) >> 6;
            }
            firL = (firL >> 1) & ~1;
            firR = (firR >> 1) & ~1;
            if (firL > 32767) firL = 32767; else if (firL < -32768) firL = -32768;
            if (firR > 32767) firR = 32767; else if (firR < -32768) firR = -32768;

            eHL = (firL * this.evolL) >> 7;
            eHR = (firR * this.evolR) >> 7;

            mOutL += eHL;
            mOutR += eHR;

            let eWL = eOutL + ((firL * this.efb) >> 7);
            let eWR = eOutR + ((firR * this.efb) >> 7);
            if (eWL > 32767) eWL = 32767; else if (eWL < -32768) eWL = -32768;
            if (eWR > 32767) eWR = 32767; else if (eWR < -32768) eWR = -32768;

            this.apu_ram[echoAddr & 0xFFFF] = eWL & 0xFF;
            this.apu_ram[(echoAddr + 1) & 0xFFFF] = (eWL >> 8) & 0xFF;
            this.apu_ram[(echoAddr + 2) & 0xFFFF] = eWR & 0xFF;
            this.apu_ram[(echoAddr + 3) & 0xFFFF] = (eWR >> 8) & 0xFF;
        }

        const echoSize = (this.echoLength > 0 ? this.echoLength : 1) * 4;
        this.echoPointer = (this.echoPointer + 4) % echoSize;

        if (mOutL > 32767) mOutL = 32767; else if (mOutL < -32768) mOutL = -32768;
        if (mOutR > 32767) mOutR = 32767; else if (mOutR < -32768) mOutR = -32768;

        this.outL = mOutL;
        this.outR = mOutR;

        if (this.samplePos < this.sampleBufferL.length) {
            this.sampleBufferL[this.samplePos] = mOutL / 32768.0;
            this.sampleBufferR[this.samplePos] = mOutR / 32768.0;
            this.samplePos++;
        }
    }
}

class Voice {
    constructor() {
        this.reset();
    }

    reset() {
        this.volL = 0; this.volR = 0;
        this.pitch = 0;
        this.srcn = 0;
        this.adcr = 0;
        this.gain = 0;
        this.envx = 0;
        this.outx = 0;
        this.state = 'STOP';
        this.decodeOffset = 0;
        this.brrLoopPtr = 0;
        this.history = new Int32Array(4);
        this.historyIdx = 0;
        this.pitchCounter = 0;
        this.s1 = 0; this.s2 = 0;
        this.decoded = new Int32Array(16);
        this.decodeIdx = 16;
        this.envCounter = 0;
    }

    static envRatePeriod(rate) {
        // Approximate S-DSP envelope rate periods in output samples.
        // 0 means "never" for variable-rate envelope modes.
        const table = [
            0, 2048, 1536, 1280, 1024, 768, 640, 512,
            384, 320, 256, 192, 160, 128, 96, 80,
            64, 48, 40, 32, 24, 20, 16, 12,
            10, 8, 6, 5, 4, 3, 2, 1
        ];
        return table[rate & 0x1F];
    }

    envTick(rate) {
        const period = Voice.envRatePeriod(rate);
        if (period <= 0) return false;
        this.envCounter++;
        if (this.envCounter >= period) {
            this.envCounter = 0;
            return true;
        }
        return false;
    }

    stepEnvelope() {
        // KOF forces Release regardless of the ADSR/GAIN mode bit (adsr1 bit7):
        // once a voice is keyed off, envx always decreases by 8 per step (0x80
        // in this 15-bit-scaled envx) until it hits 0, then the voice stops.
        if (this.state === 'RELEASE') {
            this.envx -= 0x80;
            if (this.envx <= 0) {
                this.envx = 0;
                this.state = 'STOP';
            }
            if (this.envx < 0) this.envx = 0;
            if (this.envx > 0x7FFF) this.envx = 0x7FFF;
            return;
        }

        const adsr1 = this.adcr & 0xFF;
        const adsr2 = (this.adcr >> 8) & 0xFF;

        if (!(adsr1 & 0x80)) {
            // GAIN processing
            const mode = this.gain >> 5;
            const gainRate = this.gain & 0x1F;
            if (mode < 4) {
                this.envx = (this.gain & 0x7F) << 8;
            } else {
                if (mode === 4 || mode === 5) {
                    if (this.envTick(gainRate)) {
                        if (mode === 4) this.envx -= 0x200; // linear decrease (0x20 in 11-bit → 0x200 in 15-bit)
                        else this.envx -= (this.envx >> 8) + 1; // exponential decrease (self-scaling)
                    }
                } else if (mode === 6) {
                    if (this.envTick(gainRate)) this.envx += 0x200; // linear increase
                } else if (mode === 7) {
                    if (this.envTick(gainRate)) {
                        // Bent line increase: linear until high range, then slower.
                        if (this.envx < 0x6000) this.envx += 0x200;
                        else this.envx += 0x080;
                    }
                }
            }
        } else {
            // ADSR processing
            if (this.state === 'ATTACK') {
                const attackRate = (adsr1 & 0x0F) * 2 + 1;
                if (this.envTick(attackRate)) {
                    // Fastest attack uses larger envelope step.
                    // In 11-bit envx: +1024 for rate=31; +32 for others.
                    // Scaled to 15-bit (×16): 0x4000 vs 0x200.
                    this.envx += (attackRate >= 31) ? 0x4000 : 0x200;
                    if (this.envx >= 0x7FFF) {
                        this.envx = 0x7FFF;
                        this.state = 'DECAY';
                    }
                }
            } else if (this.state === 'DECAY') {
                const decayRate = ((adsr1 >> 4) & 0x07) * 2 + 16;
                if (this.envTick(decayRate)) {
                    this.envx -= (this.envx >> 8) + 1;
                    const sl = (adsr2 >> 5) & 0x07;
                    // envx is 15-bit (0–0x7FFF). Sustain threshold = (sl+1) * 4096.
                    // For sl=7: target=32768 > max envx=32767 → immediate SUSTAIN (correct).
                    const target = (sl + 1) << 12;
                    if (this.envx <= target) {
                        this.state = 'SUSTAIN';
                    }
                }
            } else if (this.state === 'SUSTAIN') {
                const sustainRate = adsr2 & 0x1F;
                if (this.envTick(sustainRate)) {
                    this.envx -= (this.envx >> 8) + 1;
                }
            }
        }
        if (this.envx < 0) this.envx = 0;
        if (this.envx > 0x7FFF) this.envx = 0x7FFF;
    }
}

exports.DSP = DSP;

};

registry['DSP1'] = function(module,exports,require) {
// DSP-1 math coprocessor High-Level Emulation.
// Command set and fixed-point algorithms ported from the snes9x DSP1 HLE core
// (dsp1.cpp), which itself is the result of community reverse-engineering of
// the real NEC uPD96050-based DSP-1 chip used by Super Mario Kart, Pilotwings,
// Ace o Nerae!, etc.
//
// Register interface (as seen by the SNES CPU):
//   DR (Data Register)   - mirrored across $xx:6000-$xx:6FFF, read/write, byte granularity
//   SR (Status Register) - mirrored across $xx:7000-$xx:7FFF, read-only, always 0x80
//                           (bit7 set => Rqm=1 => "ready", so LDA/BPL polling loops exit immediately)

function i16(x) {
  return (x << 16) >> 16;
}

function i32(x) {
  return x | 0;
}

function readWord(arr, offset) {
  return arr[offset] | (arr[offset + 1] << 8);
}

function writeWord(arr, offset, value) {
  arr[offset] = value & 0xFF;
  arr[offset + 1] = (value >> 8) & 0xFF;
}

const DSP1ROM = new Uint16Array([
  0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
  0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
  0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
  0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
  0x0000, 0x0000, 0x0001, 0x0002, 0x0004, 0x0008, 0x0010, 0x0020,
  0x0040, 0x0080, 0x0100, 0x0200, 0x0400, 0x0800, 0x1000, 0x2000,
  0x4000, 0x7fff, 0x4000, 0x2000, 0x1000, 0x0800, 0x0400, 0x0200,
  0x0100, 0x0080, 0x0040, 0x0020, 0x0001, 0x0008, 0x0004, 0x0002,
  0x0001, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
  0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
  0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
  0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
  0x0000, 0x0000, 0x8000, 0xffe5, 0x0100, 0x7fff, 0x7f02, 0x7e08,
  0x7d12, 0x7c1f, 0x7b30, 0x7a45, 0x795d, 0x7878, 0x7797, 0x76ba,
  0x75df, 0x7507, 0x7433, 0x7361, 0x7293, 0x71c7, 0x70fe, 0x7038,
  0x6f75, 0x6eb4, 0x6df6, 0x6d3a, 0x6c81, 0x6bca, 0x6b16, 0x6a64,
  0x69b4, 0x6907, 0x685b, 0x67b2, 0x670b, 0x6666, 0x65c4, 0x6523,
  0x6484, 0x63e7, 0x634c, 0x62b3, 0x621c, 0x6186, 0x60f2, 0x6060,
  0x5fd0, 0x5f41, 0x5eb5, 0x5e29, 0x5d9f, 0x5d17, 0x5c91, 0x5c0c,
  0x5b88, 0x5b06, 0x5a85, 0x5a06, 0x5988, 0x590b, 0x5890, 0x5816,
  0x579d, 0x5726, 0x56b0, 0x563b, 0x55c8, 0x5555, 0x54e4, 0x5474,
  0x5405, 0x5398, 0x532b, 0x52bf, 0x5255, 0x51ec, 0x5183, 0x511c,
  0x50b6, 0x5050, 0x4fec, 0x4f89, 0x4f26, 0x4ec5, 0x4e64, 0x4e05,
  0x4da6, 0x4d48, 0x4cec, 0x4c90, 0x4c34, 0x4bda, 0x4b81, 0x4b28,
  0x4ad0, 0x4a79, 0x4a23, 0x49cd, 0x4979, 0x4925, 0x48d1, 0x487f,
  0x482d, 0x47dc, 0x478c, 0x473c, 0x46ed, 0x469f, 0x4651, 0x4604,
  0x45b8, 0x456c, 0x4521, 0x44d7, 0x448d, 0x4444, 0x43fc, 0x43b4,
  0x436d, 0x4326, 0x42e0, 0x429a, 0x4255, 0x4211, 0x41cd, 0x4189,
  0x4146, 0x4104, 0x40c2, 0x4081, 0x4040, 0x3fff, 0x41f7, 0x43e1,
  0x45bd, 0x478d, 0x4951, 0x4b0b, 0x4cbb, 0x4e61, 0x4fff, 0x5194,
  0x5322, 0x54a9, 0x5628, 0x57a2, 0x5914, 0x5a81, 0x5be9, 0x5d4a,
  0x5ea7, 0x5fff, 0x6152, 0x62a0, 0x63ea, 0x6530, 0x6672, 0x67b0,
  0x68ea, 0x6a20, 0x6b53, 0x6c83, 0x6daf, 0x6ed9, 0x6fff, 0x7122,
  0x7242, 0x735f, 0x747a, 0x7592, 0x76a7, 0x77ba, 0x78cb, 0x79d9,
  0x7ae5, 0x7bee, 0x7cf5, 0x7dfa, 0x7efe, 0x7fff, 0x0000, 0x0324,
  0x0647, 0x096a, 0x0c8b, 0x0fab, 0x12c8, 0x15e2, 0x18f8, 0x1c0b,
  0x1f19, 0x2223, 0x2528, 0x2826, 0x2b1f, 0x2e11, 0x30fb, 0x33de,
  0x36ba, 0x398c, 0x3c56, 0x3f17, 0x41ce, 0x447a, 0x471c, 0x49b4,
  0x4c3f, 0x4ebf, 0x5133, 0x539b, 0x55f5, 0x5842, 0x5a82, 0x5cb4,
  0x5ed7, 0x60ec, 0x62f2, 0x64e8, 0x66cf, 0x68a6, 0x6a6d, 0x6c24,
  0x6dca, 0x6f5f, 0x70e2, 0x7255, 0x73b5, 0x7504, 0x7641, 0x776c,
  0x7884, 0x798a, 0x7a7d, 0x7b5d, 0x7c29, 0x7ce3, 0x7d8a, 0x7e1d,
  0x7e9d, 0x7f09, 0x7f62, 0x7fa7, 0x7fd8, 0x7ff6, 0x7fff, 0x7ff6,
  0x7fd8, 0x7fa7, 0x7f62, 0x7f09, 0x7e9d, 0x7e1d, 0x7d8a, 0x7ce3,
  0x7c29, 0x7b5d, 0x7a7d, 0x798a, 0x7884, 0x776c, 0x7641, 0x7504,
  0x73b5, 0x7255, 0x70e2, 0x6f5f, 0x6dca, 0x6c24, 0x6a6d, 0x68a6,
  0x66cf, 0x64e8, 0x62f2, 0x60ec, 0x5ed7, 0x5cb4, 0x5a82, 0x5842,
  0x55f5, 0x539b, 0x5133, 0x4ebf, 0x4c3f, 0x49b4, 0x471c, 0x447a,
  0x41ce, 0x3f17, 0x3c56, 0x398c, 0x36ba, 0x33de, 0x30fb, 0x2e11,
  0x2b1f, 0x2826, 0x2528, 0x2223, 0x1f19, 0x1c0b, 0x18f8, 0x15e2,
  0x12c8, 0x0fab, 0x0c8b, 0x096a, 0x0647, 0x0324, 0x7fff, 0x7ff6,
  0x7fd8, 0x7fa7, 0x7f62, 0x7f09, 0x7e9d, 0x7e1d, 0x7d8a, 0x7ce3,
  0x7c29, 0x7b5d, 0x7a7d, 0x798a, 0x7884, 0x776c, 0x7641, 0x7504,
  0x73b5, 0x7255, 0x70e2, 0x6f5f, 0x6dca, 0x6c24, 0x6a6d, 0x68a6,
  0x66cf, 0x64e8, 0x62f2, 0x60ec, 0x5ed7, 0x5cb4, 0x5a82, 0x5842,
  0x55f5, 0x539b, 0x5133, 0x4ebf, 0x4c3f, 0x49b4, 0x471c, 0x447a,
  0x41ce, 0x3f17, 0x3c56, 0x398c, 0x36ba, 0x33de, 0x30fb, 0x2e11,
  0x2b1f, 0x2826, 0x2528, 0x2223, 0x1f19, 0x1c0b, 0x18f8, 0x15e2,
  0x12c8, 0x0fab, 0x0c8b, 0x096a, 0x0647, 0x0324, 0x0000, 0xfcdc,
  0xf9b9, 0xf696, 0xf375, 0xf055, 0xed38, 0xea1e, 0xe708, 0xe3f5,
  0xe0e7, 0xdddd, 0xdad8, 0xd7da, 0xd4e1, 0xd1ef, 0xcf05, 0xcc22,
  0xc946, 0xc674, 0xc3aa, 0xc0e9, 0xbe32, 0xbb86, 0xb8e4, 0xb64c,
  0xb3c1, 0xb141, 0xaecd, 0xac65, 0xaa0b, 0xa7be, 0xa57e, 0xa34c,
  0xa129, 0x9f14, 0x9d0e, 0x9b18, 0x9931, 0x975a, 0x9593, 0x93dc,
  0x9236, 0x90a1, 0x8f1e, 0x8dab, 0x8c4b, 0x8afc, 0x89bf, 0x8894,
  0x877c, 0x8676, 0x8583, 0x84a3, 0x83d7, 0x831d, 0x8276, 0x81e3,
  0x8163, 0x80f7, 0x809e, 0x8059, 0x8028, 0x800a, 0x6488, 0x0080,
  0x03ff, 0x0116, 0x0002, 0x0080, 0x4000, 0x3fd7, 0x3faf, 0x3f86,
  0x3f5d, 0x3f34, 0x3f0c, 0x3ee3, 0x3eba, 0x3e91, 0x3e68, 0x3e40,
  0x3e17, 0x3dee, 0x3dc5, 0x3d9c, 0x3d74, 0x3d4b, 0x3d22, 0x3cf9,
  0x3cd0, 0x3ca7, 0x3c7f, 0x3c56, 0x3c2d, 0x3c04, 0x3bdb, 0x3bb2,
  0x3b89, 0x3b60, 0x3b37, 0x3b0e, 0x3ae5, 0x3abc, 0x3a93, 0x3a69,
  0x3a40, 0x3a17, 0x39ee, 0x39c5, 0x399c, 0x3972, 0x3949, 0x3920,
  0x38f6, 0x38cd, 0x38a4, 0x387a, 0x3851, 0x3827, 0x37fe, 0x37d4,
  0x37aa, 0x3781, 0x3757, 0x372d, 0x3704, 0x36da, 0x36b0, 0x3686,
  0x365c, 0x3632, 0x3609, 0x35df, 0x35b4, 0x358a, 0x3560, 0x3536,
  0x350c, 0x34e1, 0x34b7, 0x348d, 0x3462, 0x3438, 0x340d, 0x33e3,
  0x33b8, 0x338d, 0x3363, 0x3338, 0x330d, 0x32e2, 0x32b7, 0x328c,
  0x3261, 0x3236, 0x320b, 0x31df, 0x31b4, 0x3188, 0x315d, 0x3131,
  0x3106, 0x30da, 0x30ae, 0x3083, 0x3057, 0x302b, 0x2fff, 0x2fd2,
  0x2fa6, 0x2f7a, 0x2f4d, 0x2f21, 0x2ef4, 0x2ec8, 0x2e9b, 0x2e6e,
  0x2e41, 0x2e14, 0x2de7, 0x2dba, 0x2d8d, 0x2d60, 0x2d32, 0x2d05,
  0x2cd7, 0x2ca9, 0x2c7b, 0x2c4d, 0x2c1f, 0x2bf1, 0x2bc3, 0x2b94,
  0x2b66, 0x2b37, 0x2b09, 0x2ada, 0x2aab, 0x2a7c, 0x2a4c, 0x2a1d,
  0x29ed, 0x29be, 0x298e, 0x295e, 0x292e, 0x28fe, 0x28ce, 0x289d,
  0x286d, 0x283c, 0x280b, 0x27da, 0x27a9, 0x2777, 0x2746, 0x2714,
  0x26e2, 0x26b0, 0x267e, 0x264c, 0x2619, 0x25e7, 0x25b4, 0x2581,
  0x254d, 0x251a, 0x24e6, 0x24b2, 0x247e, 0x244a, 0x2415, 0x23e1,
  0x23ac, 0x2376, 0x2341, 0x230b, 0x22d6, 0x229f, 0x2269, 0x2232,
  0x21fc, 0x21c4, 0x218d, 0x2155, 0x211d, 0x20e5, 0x20ad, 0x2074,
  0x203b, 0x2001, 0x1fc7, 0x1f8d, 0x1f53, 0x1f18, 0x1edd, 0x1ea1,
  0x1e66, 0x1e29, 0x1ded, 0x1db0, 0x1d72, 0x1d35, 0x1cf6, 0x1cb8,
  0x1c79, 0x1c39, 0x1bf9, 0x1bb8, 0x1b77, 0x1b36, 0x1af4, 0x1ab1,
  0x1a6e, 0x1a2a, 0x19e6, 0x19a1, 0x195c, 0x1915, 0x18ce, 0x1887,
  0x183f, 0x17f5, 0x17ac, 0x1761, 0x1715, 0x16c9, 0x167c, 0x162e,
  0x15df, 0x158e, 0x153d, 0x14eb, 0x1497, 0x1442, 0x13ec, 0x1395,
  0x133c, 0x12e2, 0x1286, 0x1228, 0x11c9, 0x1167, 0x1104, 0x109e,
  0x1036, 0x0fcc, 0x0f5f, 0x0eef, 0x0e7b, 0x0e04, 0x0d89, 0x0d0a,
  0x0c86, 0x0bfd, 0x0b6d, 0x0ad6, 0x0a36, 0x098d, 0x08d7, 0x0811,
  0x0736, 0x063e, 0x0519, 0x039a, 0x0000, 0x7fff, 0x0100, 0x0080,
  0x021d, 0x00c8, 0x00ce, 0x0048, 0x0a26, 0x277a, 0x00ce, 0x6488,
  0x14ac, 0x0001, 0x00f9, 0x00fc, 0x00ff, 0x00fc, 0x00f9, 0xffff,
  0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
  0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
  0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
  0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
  0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
  0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
  0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
  0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
  0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
  0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
  0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
  0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
  0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
  0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
  0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
  0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
  0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
  0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
  0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
  0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
  0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
  0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff,
  0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff
]);

const MUL_TABLE = new Int16Array([
  0x0000, 0x0003, 0x0006, 0x0009, 0x000c, 0x000f, 0x0012, 0x0015,
  0x0019, 0x001c, 0x001f, 0x0022, 0x0025, 0x0028, 0x002b, 0x002f,
  0x0032, 0x0035, 0x0038, 0x003b, 0x003e, 0x0041, 0x0045, 0x0048,
  0x004b, 0x004e, 0x0051, 0x0054, 0x0057, 0x005b, 0x005e, 0x0061,
  0x0064, 0x0067, 0x006a, 0x006d, 0x0071, 0x0074, 0x0077, 0x007a,
  0x007d, 0x0080, 0x0083, 0x0087, 0x008a, 0x008d, 0x0090, 0x0093,
  0x0096, 0x0099, 0x009d, 0x00a0, 0x00a3, 0x00a6, 0x00a9, 0x00ac,
  0x00af, 0x00b3, 0x00b6, 0x00b9, 0x00bc, 0x00bf, 0x00c2, 0x00c5,
  0x00c9, 0x00cc, 0x00cf, 0x00d2, 0x00d5, 0x00d8, 0x00db, 0x00df,
  0x00e2, 0x00e5, 0x00e8, 0x00eb, 0x00ee, 0x00f1, 0x00f5, 0x00f8,
  0x00fb, 0x00fe, 0x0101, 0x0104, 0x0107, 0x010b, 0x010e, 0x0111,
  0x0114, 0x0117, 0x011a, 0x011d, 0x0121, 0x0124, 0x0127, 0x012a,
  0x012d, 0x0130, 0x0133, 0x0137, 0x013a, 0x013d, 0x0140, 0x0143,
  0x0146, 0x0149, 0x014d, 0x0150, 0x0153, 0x0156, 0x0159, 0x015c,
  0x015f, 0x0163, 0x0166, 0x0169, 0x016c, 0x016f, 0x0172, 0x0175,
  0x0178, 0x017c, 0x017f, 0x0182, 0x0185, 0x0188, 0x018b, 0x018e,
  0x0192, 0x0195, 0x0198, 0x019b, 0x019e, 0x01a1, 0x01a4, 0x01a8,
  0x01ab, 0x01ae, 0x01b1, 0x01b4, 0x01b7, 0x01ba, 0x01be, 0x01c1,
  0x01c4, 0x01c7, 0x01ca, 0x01cd, 0x01d0, 0x01d4, 0x01d7, 0x01da,
  0x01dd, 0x01e0, 0x01e3, 0x01e6, 0x01ea, 0x01ed, 0x01f0, 0x01f3,
  0x01f6, 0x01f9, 0x01fc, 0x0200, 0x0203, 0x0206, 0x0209, 0x020c,
  0x020f, 0x0212, 0x0216, 0x0219, 0x021c, 0x021f, 0x0222, 0x0225,
  0x0228, 0x022c, 0x022f, 0x0232, 0x0235, 0x0238, 0x023b, 0x023e,
  0x0242, 0x0245, 0x0248, 0x024b, 0x024e, 0x0251, 0x0254, 0x0258,
  0x025b, 0x025e, 0x0261, 0x0264, 0x0267, 0x026a, 0x026e, 0x0271,
  0x0274, 0x0277, 0x027a, 0x027d, 0x0280, 0x0284, 0x0287, 0x028a,
  0x028d, 0x0290, 0x0293, 0x0296, 0x029a, 0x029d, 0x02a0, 0x02a3,
  0x02a6, 0x02a9, 0x02ac, 0x02b0, 0x02b3, 0x02b6, 0x02b9, 0x02bc,
  0x02bf, 0x02c2, 0x02c6, 0x02c9, 0x02cc, 0x02cf, 0x02d2, 0x02d5,
  0x02d8, 0x02db, 0x02df, 0x02e2, 0x02e5, 0x02e8, 0x02eb, 0x02ee,
  0x02f1, 0x02f5, 0x02f8, 0x02fb, 0x02fe, 0x0301, 0x0304, 0x0307,
  0x030b, 0x030e, 0x0311, 0x0314, 0x0317, 0x031a, 0x031d, 0x0321
]);

const SIN_TABLE = new Int16Array([
  0x0000, 0x0324, 0x0647, 0x096a, 0x0c8b, 0x0fab, 0x12c8, 0x15e2,
  0x18f8, 0x1c0b, 0x1f19, 0x2223, 0x2528, 0x2826, 0x2b1f, 0x2e11,
  0x30fb, 0x33de, 0x36ba, 0x398c, 0x3c56, 0x3f17, 0x41ce, 0x447a,
  0x471c, 0x49b4, 0x4c3f, 0x4ebf, 0x5133, 0x539b, 0x55f5, 0x5842,
  0x5a82, 0x5cb4, 0x5ed7, 0x60ec, 0x62f2, 0x64e8, 0x66cf, 0x68a6,
  0x6a6d, 0x6c24, 0x6dca, 0x6f5f, 0x70e2, 0x7255, 0x73b5, 0x7504,
  0x7641, 0x776c, 0x7884, 0x798a, 0x7a7d, 0x7b5d, 0x7c29, 0x7ce3,
  0x7d8a, 0x7e1d, 0x7e9d, 0x7f09, 0x7f62, 0x7fa7, 0x7fd8, 0x7ff6,
  0x7fff, 0x7ff6, 0x7fd8, 0x7fa7, 0x7f62, 0x7f09, 0x7e9d, 0x7e1d,
  0x7d8a, 0x7ce3, 0x7c29, 0x7b5d, 0x7a7d, 0x798a, 0x7884, 0x776c,
  0x7641, 0x7504, 0x73b5, 0x7255, 0x70e2, 0x6f5f, 0x6dca, 0x6c24,
  0x6a6d, 0x68a6, 0x66cf, 0x64e8, 0x62f2, 0x60ec, 0x5ed7, 0x5cb4,
  0x5a82, 0x5842, 0x55f5, 0x539b, 0x5133, 0x4ebf, 0x4c3f, 0x49b4,
  0x471c, 0x447a, 0x41ce, 0x3f17, 0x3c56, 0x398c, 0x36ba, 0x33de,
  0x30fb, 0x2e11, 0x2b1f, 0x2826, 0x2528, 0x2223, 0x1f19, 0x1c0b,
  0x18f8, 0x15e2, 0x12c8, 0x0fab, 0x0c8b, 0x096a, 0x0647, 0x0324,
  -0x0000, -0x0324, -0x0647, -0x096a, -0x0c8b, -0x0fab, -0x12c8, -0x15e2,
  -0x18f8, -0x1c0b, -0x1f19, -0x2223, -0x2528, -0x2826, -0x2b1f, -0x2e11,
  -0x30fb, -0x33de, -0x36ba, -0x398c, -0x3c56, -0x3f17, -0x41ce, -0x447a,
  -0x471c, -0x49b4, -0x4c3f, -0x4ebf, -0x5133, -0x539b, -0x55f5, -0x5842,
  -0x5a82, -0x5cb4, -0x5ed7, -0x60ec, -0x62f2, -0x64e8, -0x66cf, -0x68a6,
  -0x6a6d, -0x6c24, -0x6dca, -0x6f5f, -0x70e2, -0x7255, -0x73b5, -0x7504,
  -0x7641, -0x776c, -0x7884, -0x798a, -0x7a7d, -0x7b5d, -0x7c29, -0x7ce3,
  -0x7d8a, -0x7e1d, -0x7e9d, -0x7f09, -0x7f62, -0x7fa7, -0x7fd8, -0x7ff6,
  -0x7fff, -0x7ff6, -0x7fd8, -0x7fa7, -0x7f62, -0x7f09, -0x7e9d, -0x7e1d,
  -0x7d8a, -0x7ce3, -0x7c29, -0x7b5d, -0x7a7d, -0x798a, -0x7884, -0x776c,
  -0x7641, -0x7504, -0x73b5, -0x7255, -0x70e2, -0x6f5f, -0x6dca, -0x6c24,
  -0x6a6d, -0x68a6, -0x66cf, -0x64e8, -0x62f2, -0x60ec, -0x5ed7, -0x5cb4,
  -0x5a82, -0x5842, -0x55f5, -0x539b, -0x5133, -0x4ebf, -0x4c3f, -0x49b4,
  -0x471c, -0x447a, -0x41ce, -0x3f17, -0x3c56, -0x398c, -0x36ba, -0x33de,
  -0x30fb, -0x2e11, -0x2b1f, -0x2826, -0x2528, -0x2223, -0x1f19, -0x1c0b,
  -0x18f8, -0x15e2, -0x12c8, -0x0fab, -0x0c8b, -0x096a, -0x0647, -0x0324
]);

function dspSin(angle) {
  angle = i16(angle);
  if (angle < 0) {
    if (angle === -32768) return 0;
    return i16(-dspSin(-angle));
  }
  let s = SIN_TABLE[angle >> 8] + ((MUL_TABLE[angle & 0xff] * SIN_TABLE[0x40 + (angle >> 8)]) >> 15);
  if (s > 32767) s = 32767;
  return i16(s);
}

function dspCos(angle) {
  angle = i16(angle);
  if (angle < 0) {
    if (angle === -32768) return -32768;
    angle = -angle;
  }
  let s = SIN_TABLE[0x40 + (angle >> 8)] - ((MUL_TABLE[angle & 0xff] * SIN_TABLE[angle >> 8]) >> 15);
  if (s < -32768) s = -32767;
  return i16(s);
}

// Returns [iCoefficient, iExponent]
function dspInverse(coefficient, exponent) {
  coefficient = i16(coefficient);
  exponent = i16(exponent);
  let iCoefficient, iExponent;

  if (coefficient === 0) {
    iCoefficient = 0x7fff;
    iExponent = 0x002f;
  } else {
    let sign = 1;

    if (coefficient < 0) {
      if (coefficient < -32767) coefficient = -32767;
      coefficient = -coefficient;
      sign = -1;
    }

    while (coefficient < 0x4000) {
      coefficient = i16(coefficient << 1);
      exponent = i16(exponent - 1);
    }

    if (coefficient === 0x4000) {
      if (sign === 1) {
        iCoefficient = 0x7fff;
      } else {
        iCoefficient = -0x4000;
        exponent = i16(exponent - 1);
      }
    } else {
      let idx = (((coefficient - 0x4000) >> 7) + 0x0065) & 1023;
      let v = DSP1ROM[idx];

      let t1 = (coefficient * v) >> 15;
      let t2 = (-v * t1) >> 15;
      v = i16((v + t2) << 1);

      t1 = (coefficient * v) >> 15;
      t2 = (-v * t1) >> 15;
      v = i16((v + t2) << 1);

      iCoefficient = i16(v * sign);
    }

    iExponent = i16(1 - exponent);
  }

  return [iCoefficient, iExponent];
}

// Returns [coefficient, exponent] where exponent = exp - e
function dspNormalize(m, exp) {
  m = i16(m);
  let e = 0;
  let i = 0x4000;

  if (m < 0) {
    while ((m & i) && i) { i >>= 1; e++; }
  } else {
    while (!(m & i) && i) { i >>= 1; e++; }
  }

  let coefficient;
  if (e > 0) {
    coefficient = i16((m * DSP1ROM[0x21 + e]) << 1);
  } else {
    coefficient = m;
  }

  return [coefficient, i16(exp - e)];
}

// Returns [coefficient, exponent] where exponent = e (output only, not relative)
function dspNormalizeDouble(product) {
  product = i32(product);
  let n = i16(product & 0x7fff);
  let m = i16(product >> 15);
  let e = 0;
  let i = 0x4000;

  if (m < 0) {
    while ((m & i) && i) { i >>= 1; e++; }
  } else {
    while (!(m & i) && i) { i >>= 1; e++; }
  }

  let coefficient;
  if (e > 0) {
    coefficient = i16((m * DSP1ROM[0x0021 + e]) << 1);

    if (e < 15) {
      coefficient = i16(coefficient + ((n * DSP1ROM[0x0040 - e]) >> 15));
    } else {
      i = 0x4000;
      if (m < 0) {
        while ((n & i) && i) { i >>= 1; e++; }
      } else {
        while (!(n & i) && i) { i >>= 1; e++; }
      }

      if (e > 15) {
        coefficient = i16((n * DSP1ROM[0x0012 + e]) << 1);
      } else {
        coefficient = i16(coefficient + n);
      }
    }
  } else {
    coefficient = m;
  }

  return [coefficient, e];
}

function dspTruncate(c, e) {
  c = i16(c);
  e = i16(e);
  if (e > 0) {
    if (c > 0) return 32767;
    if (c < 0) return -32767;
    return c;
  } else if (e < 0) {
    return i16((c * DSP1ROM[0x0031 + e]) >> 15);
  }
  return c;
}

function dspShiftR(c, e) {
  return i16((c * DSP1ROM[0x0031 + e]) >> 15);
}

class DSP1 {
  constructor() {
    this.reset();
  }

  reset() {
    this.waiting4command = true;
    this.firstParameter = true;
    this.command = 0;
    this.inCount = 0;
    this.inIndex = 0;
    this.outCount = 0;
    this.outIndex = 0;
    this.parameters = new Uint8Array(512);
    this.output = new Uint8Array(2048 + 16);

    // Projection state (set by Op02, consumed by Op0A/Op06/Op0E)
    this.CentreX = 0; this.CentreY = 0; this.VOffset = 0;
    this.VPlane_C = 0; this.VPlane_E = 0;
    this.SinAas = 0; this.CosAas = 0; this.SinAzs = 0; this.CosAzs = 0;
    this.SinAZS = 0; this.CosAZS = 0;
    this.SecAZS_C1 = 0; this.SecAZS_E1 = 0; this.SecAZS_C2 = 0; this.SecAZS_E2 = 0;
    this.Nx = 0; this.Ny = 0; this.Nz = 0;
    this.Gx = 0; this.Gy = 0; this.Gz = 0;
    this.C_Les = 0; this.E_Les = 0; this.G_Les = 0;

    // Attitude matrices (Op01/11/21), 3x3 each
    this.matrixA = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    this.matrixB = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    this.matrixC = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];

    // Raster iteration counter (Op0A)
    this.Op0AVS = 0;
    this.Op0AA = 0; this.Op0AB = 0; this.Op0AC = 0; this.Op0AD = 0;

    // Op1C rotation persistent state
    this.Op1CXBR = 0; this.Op1CYBR = 0; this.Op1CZBR = 0;
  }

  // ---- DSP1SetByte/DSP1GetByte protocol (ported from snes9x dsp1.cpp) ----

  setByte(byte) {
    byte &= 0xFF;

    if ((this.command === 0x0a || this.command === 0x1a) && this.outCount !== 0) {
      this.outCount--;
      this.outIndex++;
      return;
    }

    if (this.waiting4command) {
      this.command = byte;
      this.inIndex = 0;
      this.waiting4command = false;
      this.firstParameter = true;

      switch (byte) {
        case 0x00: this.inCount = 2; break;
        case 0x30:
        case 0x10: this.inCount = 2; break;
        case 0x20: this.inCount = 2; break;
        case 0x24:
        case 0x04: this.inCount = 2; break;
        case 0x08: this.inCount = 3; break;
        case 0x18: this.inCount = 4; break;
        case 0x28: this.inCount = 3; break;
        case 0x38: this.inCount = 4; break;
        case 0x2c:
        case 0x0c: this.inCount = 3; break;
        case 0x3c:
        case 0x1c: this.inCount = 6; break;
        case 0x32:
        case 0x22:
        case 0x12:
        case 0x02: this.inCount = 7; break;
        case 0x0a: this.inCount = 1; break;
        case 0x3a:
        case 0x2a:
        case 0x1a:
          this.command = 0x1a;
          this.inCount = 1;
          break;
        case 0x16:
        case 0x26:
        case 0x36:
        case 0x06: this.inCount = 3; break;
        case 0x1e:
        case 0x2e:
        case 0x3e:
        case 0x0e: this.inCount = 2; break;
        case 0x05:
        case 0x35:
        case 0x31:
        case 0x01: this.inCount = 4; break;
        case 0x15:
        case 0x11: this.inCount = 4; break;
        case 0x25:
        case 0x21: this.inCount = 4; break;
        case 0x09:
        case 0x39:
        case 0x3d:
        case 0x0d: this.inCount = 3; break;
        case 0x19:
        case 0x1d: this.inCount = 3; break;
        case 0x29:
        case 0x2d: this.inCount = 3; break;
        case 0x33:
        case 0x03: this.inCount = 3; break;
        case 0x13: this.inCount = 3; break;
        case 0x23: this.inCount = 3; break;
        case 0x3b:
        case 0x0b: this.inCount = 3; break;
        case 0x1b: this.inCount = 3; break;
        case 0x2b: this.inCount = 3; break;
        case 0x34:
        case 0x14: this.inCount = 6; break;
        case 0x07:
        case 0x0f: this.inCount = 1; break;
        case 0x27:
        case 0x2f: this.inCount = 1; break;
        case 0x17:
        case 0x37:
        case 0x3f:
          this.command = 0x1f;
        // fall through
        case 0x1f: this.inCount = 1; break;
        default:
        case 0x80:
          this.inCount = 0;
          this.waiting4command = true;
          this.firstParameter = true;
          break;
      }

      this.inCount <<= 1;
    } else {
      this.parameters[this.inIndex] = byte;
      this.firstParameter = false;
      this.inIndex++;
    }

    if (this.waiting4command || (this.firstParameter && byte === 0x80)) {
      this.waiting4command = true;
      this.firstParameter = false;
    } else if (this.firstParameter && (this.inCount !== 0 || (this.inCount === 0 && this.inIndex === 0))) {
      // Waiting for more parameter bytes before the command can run.
    } else if (this.inCount) {
      if (--this.inCount === 0) {
        this.waiting4command = true;
        this.outIndex = 0;
        this._execute();
      }
    }
  }

  getByte() {
    let t;

    if (this.outCount) {
      t = this.output[this.outIndex];
      this.outIndex++;

      if (--this.outCount === 0) {
        if (this.command === 0x0a || this.command === 0x1a) {
          this._rasterStep();
          this.outCount = 8;
          this.outIndex = 0;
          writeWord(this.output, 0, this.Op0AA);
          writeWord(this.output, 2, this.Op0AB);
          writeWord(this.output, 4, this.Op0AC);
          writeWord(this.output, 6, this.Op0AD);
        }

        if (this.command === 0x1f) {
          if ((this.outIndex % 2) !== 0) {
            t = DSP1ROM[this.outIndex >> 1] & 0xFF;
          } else {
            t = (DSP1ROM[this.outIndex >> 1] >> 8) & 0xFF;
          }
        }
      }

      this.waiting4command = true;
    } else {
      t = 0x80;
    }

    return t & 0xFF;
  }

  // ---- Command dispatch ----

  _execute() {
    const P = this.parameters;
    const rs = (off) => i16(readWord(P, off));
    const ru = (off) => readWord(P, off);

    switch (this.command) {
      case 0x1f: // Firmware ROM dump
        this.outCount = 2048;
        break;

      case 0x00: { // Multiply
        const result = i16((rs(0) * rs(2)) >> 15);
        this.outCount = 2;
        writeWord(this.output, 0, result);
        break;
      }

      case 0x20: { // Multiply, +1
        const result = i16(i16((rs(0) * rs(2)) >> 15) + 1);
        this.outCount = 2;
        writeWord(this.output, 0, result);
        break;
      }

      case 0x30:
      case 0x10: { // Inverse
        const [c, e] = dspInverse(rs(0), rs(2));
        this.outCount = 4;
        writeWord(this.output, 0, c);
        writeWord(this.output, 2, e);
        break;
      }

      case 0x24:
      case 0x04: { // Sin/Cos * radius
        const angle = rs(0);
        const radius = ru(2);
        this.outCount = 4;
        writeWord(this.output, 0, i16((dspSin(angle) * radius) >> 15));
        writeWord(this.output, 2, i16((dspCos(angle) * radius) >> 15));
        break;
      }

      case 0x08: { // Squared length (32-bit)
        const x = rs(0), y = rs(2), z = rs(4);
        const size = (x * x + y * y + z * z) << 1;
        this.outCount = 4;
        writeWord(this.output, 0, size & 0xffff);
        writeWord(this.output, 2, (size >>> 16) & 0xffff);
        break;
      }

      case 0x18: { // Range check
        const x = rs(0), y = rs(2), z = rs(4), r = rs(6);
        const d = i16((x * x + y * y + z * z - r * r) >> 15);
        this.outCount = 2;
        writeWord(this.output, 0, d);
        break;
      }

      case 0x38: { // Range check, +1
        const x = rs(0), y = rs(2), z = rs(4), r = rs(6);
        const d = i16(((x * x + y * y + z * z - r * r) >> 15) + 1);
        this.outCount = 2;
        writeWord(this.output, 0, d);
        break;
      }

      case 0x28: { // Distance (vector length)
        const x = rs(0), y = rs(2), z = rs(4);
        const radius = x * x + y * y + z * z;
        let result = 0;
        if (radius !== 0) {
          let [c, e] = dspNormalizeDouble(radius);
          if (e & 1) c = i16((c * 0x4000) >> 15);
          const pos = i16((c * 0x0040) >> 15);
          const node1 = DSP1ROM[0x00d5 + pos];
          const node2 = DSP1ROM[0x00d6 + pos];
          result = i16((((node2 - node1) * (c & 0x1ff)) >> 9) + node1);
          result = i16(result >> (e >> 1));
        }
        this.outCount = 2;
        writeWord(this.output, 0, result);
        break;
      }

      case 0x2c:
      case 0x0c: { // 2D rotate
        const a = rs(0), x1 = rs(2), y1 = rs(4);
        const sinA = dspSin(a), cosA = dspCos(a);
        const x2 = i16(((y1 * sinA) >> 15) + ((x1 * cosA) >> 15));
        const y2 = i16(((y1 * cosA) >> 15) - ((x1 * sinA) >> 15));
        this.outCount = 4;
        writeWord(this.output, 0, x2);
        writeWord(this.output, 2, y2);
        break;
      }

      case 0x3c:
      case 0x1c: { // 3D polar rotate
        const [xar, yar, zar] = this._polarRotate(rs(0), rs(2), rs(4), rs(6), rs(8), rs(10));
        this.outCount = 6;
        writeWord(this.output, 0, xar);
        writeWord(this.output, 2, yar);
        writeWord(this.output, 4, zar);
        break;
      }

      case 0x32:
      case 0x22:
      case 0x12:
      case 0x02: { // Parameter (Mode7 projection setup)
        const [vof, vva, cx, cy] = this._parameter(rs(0), rs(2), rs(4), rs(6), rs(8), rs(10), rs(12));
        this.outCount = 8;
        writeWord(this.output, 0, vof);
        writeWord(this.output, 2, vva);
        writeWord(this.output, 4, cx);
        writeWord(this.output, 6, cy);
        break;
      }

      case 0x1a: // 0x3a/0x2a aliased to 0x1a in setByte()
      case 0x0a: { // Raster (Mode7 per-scanline coefficients)
        this.Op0AVS = rs(0);
        this._rasterStep();
        this.outCount = 8;
        writeWord(this.output, 0, this.Op0AA);
        writeWord(this.output, 2, this.Op0AB);
        writeWord(this.output, 4, this.Op0AC);
        writeWord(this.output, 6, this.Op0AD);
        this.inIndex = 0;
        break;
      }

      case 0x16:
      case 0x26:
      case 0x36:
      case 0x06: { // Project object onto screen
        const [h, v, m] = this._project(rs(0), rs(2), rs(4));
        this.outCount = 6;
        writeWord(this.output, 0, h);
        writeWord(this.output, 2, v);
        writeWord(this.output, 4, m);
        break;
      }

      case 0x1e:
      case 0x2e:
      case 0x3e:
      case 0x0e: { // Target (screen -> world)
        const [x, y] = this._target(rs(0), rs(2));
        this.outCount = 4;
        writeWord(this.output, 0, x);
        writeWord(this.output, 2, y);
        break;
      }

      case 0x05:
      case 0x35:
      case 0x31:
      case 0x01: // Set attitude matrix A
        this.matrixA = this._attitudeMatrix(rs(0), rs(2), rs(4), rs(6));
        break;

      case 0x15:
      case 0x11: // Set attitude matrix B
        this.matrixB = this._attitudeMatrix(rs(0), rs(2), rs(4), rs(6));
        break;

      case 0x25:
      case 0x21: // Set attitude matrix C
        this.matrixC = this._attitudeMatrix(rs(0), rs(2), rs(4), rs(6));
        break;

      case 0x09:
      case 0x39:
      case 0x3d:
      case 0x0d: { // Objective matrix A (world -> local)
        const [f, l, u] = this._objective(this.matrixA, rs(0), rs(2), rs(4));
        this.outCount = 6;
        writeWord(this.output, 0, f);
        writeWord(this.output, 2, l);
        writeWord(this.output, 4, u);
        break;
      }

      case 0x19:
      case 0x1d: { // Objective matrix B
        const [f, l, u] = this._objective(this.matrixB, rs(0), rs(2), rs(4));
        this.outCount = 6;
        writeWord(this.output, 0, f);
        writeWord(this.output, 2, l);
        writeWord(this.output, 4, u);
        break;
      }

      case 0x29:
      case 0x2d: { // Objective matrix C
        const [f, l, u] = this._objective(this.matrixC, rs(0), rs(2), rs(4));
        this.outCount = 6;
        writeWord(this.output, 0, f);
        writeWord(this.output, 2, l);
        writeWord(this.output, 4, u);
        break;
      }

      case 0x33:
      case 0x03: { // Subjective matrix A (local -> world)
        const [x, y, z] = this._subjective(this.matrixA, rs(0), rs(2), rs(4));
        this.outCount = 6;
        writeWord(this.output, 0, x);
        writeWord(this.output, 2, y);
        writeWord(this.output, 4, z);
        break;
      }

      case 0x13: { // Subjective matrix B
        const [x, y, z] = this._subjective(this.matrixB, rs(0), rs(2), rs(4));
        this.outCount = 6;
        writeWord(this.output, 0, x);
        writeWord(this.output, 2, y);
        writeWord(this.output, 4, z);
        break;
      }

      case 0x23: { // Subjective matrix C
        const [x, y, z] = this._subjective(this.matrixC, rs(0), rs(2), rs(4));
        this.outCount = 6;
        writeWord(this.output, 0, x);
        writeWord(this.output, 2, y);
        writeWord(this.output, 4, z);
        break;
      }

      case 0x3b:
      case 0x0b: { // Scalar projection onto matrix A row 0
        const s = this._scalarProject(this.matrixA, rs(0), rs(2), rs(4));
        this.outCount = 2;
        writeWord(this.output, 0, s);
        break;
      }

      case 0x1b: { // Scalar projection onto matrix B row 0
        const s = this._scalarProject(this.matrixB, rs(0), rs(2), rs(4));
        this.outCount = 2;
        writeWord(this.output, 0, s);
        break;
      }

      case 0x2b: { // Scalar projection onto matrix C row 0
        const s = this._scalarProject(this.matrixC, rs(0), rs(2), rs(4));
        this.outCount = 2;
        writeWord(this.output, 0, s);
        break;
      }

      case 0x34:
      case 0x14: { // Rotation angle correction
        const [zrr, xrr, yrr] = this._rotationCorrection(rs(0), rs(2), rs(4), rs(6), rs(8), rs(10));
        this.outCount = 6;
        writeWord(this.output, 0, zrr);
        writeWord(this.output, 2, xrr);
        writeWord(this.output, 4, yrr);
        break;
      }

      case 0x27:
      case 0x2f: // Unknown / firmware size
        this.outCount = 2;
        writeWord(this.output, 0, 0x100);
        break;

      case 0x07:
      case 0x0f: // RAM test
        this.outCount = 2;
        writeWord(this.output, 0, 0x0000);
        break;

      default:
        break;
    }
  }

  // ---- Op helpers (ported from snes9x DSP1_OpXX) ----

  _rasterStep() {
    const [a, b, c, d] = this._raster(this.Op0AVS);
    this.Op0AA = a;
    this.Op0AB = b;
    this.Op0AC = c;
    this.Op0AD = d;
    this.Op0AVS = i16(this.Op0AVS + 1);
  }

  _raster(Vs) {
    const arg = i16(((Vs * this.SinAzs) >> 15) + this.VOffset);
    let [C, E] = dspInverse(arg, 7);
    E = i16(E + this.VPlane_E);

    const C1 = i16((C * this.VPlane_C) >> 15);
    let E1 = i16(E + this.SecAZS_E2);

    [C, E] = dspNormalize(C1, E);
    C = dspTruncate(C, E);

    const An = i16((C * this.CosAas) >> 15);
    const Cn = i16((C * this.SinAas) >> 15);

    [C, E1] = dspNormalize(i16((C1 * this.SecAZS_C2) >> 15), E1);
    C = dspTruncate(C, E1);

    const Bn = i16((C * -this.SinAas) >> 15);
    const Dn = i16((C * this.CosAas) >> 15);

    return [An, Bn, Cn, Dn];
  }

  _parameter(Fx, Fy, Fz, Lfe, Les, Aas, Azs) {
    const MaxAZS_Exp = [
      0x38b4, 0x38b7, 0x38ba, 0x38be, 0x38c0, 0x38c4, 0x38c7, 0x38ca,
      0x38ce, 0x38d0, 0x38d4, 0x38d7, 0x38da, 0x38dd, 0x38e0, 0x38e4,
    ];

    let AZS = Azs;

    this.SinAas = dspSin(Aas);
    this.CosAas = dspCos(Aas);
    this.SinAzs = dspSin(Azs);
    this.CosAzs = dspCos(Azs);

    this.Nx = i16((this.SinAzs * -this.SinAas) >> 15);
    this.Ny = i16((this.SinAzs * this.CosAas) >> 15);
    this.Nz = i16((this.CosAzs * 0x7fff) >> 15);

    const LfeNx = i16((Lfe * this.Nx) >> 15);
    const LfeNy = i16((Lfe * this.Ny) >> 15);
    const LfeNz = i16((Lfe * this.Nz) >> 15);

    this.CentreX = i16(Fx + LfeNx);
    this.CentreY = i16(Fy + LfeNy);
    const CentreZ = i16(Fz + LfeNz);

    const LesNx = i16((Les * this.Nx) >> 15);
    const LesNy = i16((Les * this.Ny) >> 15);
    const LesNz = i16((Les * this.Nz) >> 15);

    this.Gx = i16(this.CentreX - LesNx);
    this.Gy = i16(this.CentreY - LesNy);
    this.Gz = i16(CentreZ - LesNz);

    this.E_Les = 0;
    [this.C_Les, this.E_Les] = dspNormalize(Les, this.E_Les);
    this.G_Les = Les;

    let [C, E] = dspNormalize(CentreZ, 0);
    this.VPlane_C = C;
    this.VPlane_E = E;

    let MaxAZS = MaxAZS_Exp[-E];

    if (AZS < 0) {
      MaxAZS = -MaxAZS;
      if (AZS < MaxAZS + 1) AZS = MaxAZS + 1;
    } else {
      if (AZS > MaxAZS) AZS = MaxAZS;
    }

    this.SinAZS = dspSin(AZS);
    this.CosAZS = dspCos(AZS);

    [this.SecAZS_C1, this.SecAZS_E1] = dspInverse(this.CosAZS, 0);
    [C, E] = dspNormalize(i16((C * this.SecAZS_C1) >> 15), E);
    E = i16(E + this.SecAZS_E1);

    C = i16((dspTruncate(C, E) * this.SinAZS) >> 15);

    this.CentreX = i16(this.CentreX + ((C * this.SinAas) >> 15));
    this.CentreY = i16(this.CentreY - ((C * this.CosAas) >> 15));

    const Cx = this.CentreX;
    const Cy = this.CentreY;

    let Vof = 0;

    if (Azs !== AZS || Azs === MaxAZS) {
      if (Azs === -32768) Azs = -32767;

      C = i16(Azs - MaxAZS);
      if (C >= 0) C = i16(C - 1);
      let Aux = i16(~(C << 2));

      C = i16((Aux * DSP1ROM[0x0328]) >> 15);
      C = i16(((C * Aux) >> 15) + DSP1ROM[0x0327]);
      Vof = i16(Vof - (((C * Aux) >> 15) * Les >> 15));

      C = i16((Aux * Aux) >> 15);
      Aux = i16(((C * DSP1ROM[0x0324]) >> 15) + DSP1ROM[0x0325]);
      this.CosAZS = i16(this.CosAZS + (((C * Aux) >> 15) * this.CosAZS >> 15));
    }

    this.VOffset = i16((Les * this.CosAZS) >> 15);

    let CSec;
    [CSec, E] = dspInverse(this.SinAZS, 0);
    [C, E] = dspNormalize(this.VOffset, E);
    [C, E] = dspNormalize(i16((C * CSec) >> 15), E);

    if (C === -32768) {
      C = i16(C >> 1);
      E = i16(E + 1);
    }

    const Vva = dspTruncate(-C, E);

    [this.SecAZS_C2, this.SecAZS_E2] = dspInverse(this.CosAZS, 0);

    return [Vof, Vva, Cx, Cy];
  }

  _project(X, Y, Z) {
    let [Px, E4] = dspNormalizeDouble(X - this.Gx);
    let [Py, E] = dspNormalizeDouble(Y - this.Gy);
    let [Pz, E3] = dspNormalizeDouble(Z - this.Gz);

    Px = i16(Px >> 1); E4 = i16(E4 - 1);
    Py = i16(Py >> 1); E = i16(E - 1);
    Pz = i16(Pz >> 1); E3 = i16(E3 - 1);

    let refE = Math.min(E, E3, E4);

    Px = dspShiftR(Px, i16(E4 - refE));
    Py = dspShiftR(Py, i16(E - refE));
    Pz = dspShiftR(Pz, i16(E3 - refE));

    const C11 = i16(-((Px * this.Nx) >> 15));
    const C8 = i16(-((Py * this.Ny) >> 15));
    const C9 = i16(-((Pz * this.Nz) >> 15));
    const C12 = i16(C11 + C8 + C9);

    let aux4 = C12;
    refE = i16(16 - refE);
    if (refE >= 0) {
      aux4 = aux4 << refE;
    } else {
      aux4 = aux4 >> -refE;
    }
    if (aux4 === -1) aux4 = 0;
    aux4 = aux4 >> 1;

    const aux = (this.G_Les & 0xffff) + aux4;
    let [C10, E2] = dspNormalizeDouble(aux);
    E2 = i16(15 - E2);

    let [C4, E4b] = dspInverse(C10, 0);
    const C2 = i16((C4 * this.C_Les) >> 15);

    // H
    const t1 = (this.CosAas * 0x7fff) >> 15;
    const C16 = i16((Px * t1) >> 15);
    const t2 = (this.SinAas * 0x7fff) >> 15;
    const C20 = i16((Py * t2) >> 15);
    const C17 = i16(C16 + C20);

    const C18 = i16((C17 * C2) >> 15);
    const [C19, E7] = dspNormalize(C18, 0);
    const H = dspTruncate(C19, this.E_Les - E2 + refE + E7);

    // V
    const t3 = (this.CosAzs * -this.SinAas) >> 15;
    const C21 = i16((Px * t3) >> 15);
    const t4 = (this.CosAzs * this.CosAas) >> 15;
    const C22 = i16((Py * t4) >> 15);
    const t5 = (-this.SinAzs * 0x7fff) >> 15;
    const C23 = i16((Pz * t5) >> 15);
    const C24 = i16(C21 + C22 + C23);

    const C26 = i16((C24 * C2) >> 15);
    const [C25, E6] = dspNormalize(C26, 0);
    const V = dspTruncate(C25, this.E_Les - E2 + refE + E6);

    // M
    const [C6, E4c] = dspNormalize(C2, E4b);
    const M = dspTruncate(C6, E4c + this.E_Les - E2 - 7);

    return [H, V, M];
  }

  _target(H, V) {
    let arg = i16(((V * this.SinAzs) >> 15) + this.VOffset);
    let [C, E] = dspInverse(arg, 8);
    E = i16(E + this.VPlane_E);

    const C1 = i16((C * this.VPlane_C) >> 15);
    let E1 = i16(E + this.SecAZS_E1);

    H = i16(H << 8);

    [C, E] = dspNormalize(C1, E);
    C = i16((dspTruncate(C, E) * H) >> 15);

    let X = i16(this.CentreX + ((C * this.CosAas) >> 15));
    let Y = i16(this.CentreY - ((C * this.SinAas) >> 15));

    V = i16(V << 8);

    [C, E1] = dspNormalize(i16((C1 * this.SecAZS_C1) >> 15), E1);
    C = i16((dspTruncate(C, E1) * V) >> 15);

    X = i16(X + ((C * -this.SinAas) >> 15));
    Y = i16(Y + ((C * this.CosAas) >> 15));

    return [X, Y];
  }

  _attitudeMatrix(m, Zr, Yr, Xr) {
    const SinAz = dspSin(Zr), CosAz = dspCos(Zr);
    const SinAy = dspSin(Yr), CosAy = dspCos(Yr);
    const SinAx = dspSin(Xr), CosAx = dspCos(Xr);

    m = i16(m >> 1);

    const mCosAz = (m * CosAz) >> 15;
    const mSinAz = (m * SinAz) >> 15;
    const mCosAx = (m * CosAx) >> 15;
    const mSinAx = (m * SinAx) >> 15;
    const mSinAy = (m * SinAy) >> 15;

    const m00 = i16((mCosAz * CosAy) >> 15);
    const m01 = i16(-((mSinAz * CosAy) >> 15));
    const m02 = i16(mSinAy);

    const m10 = i16(((mSinAz * CosAx) >> 15) + (((mCosAz * SinAx) >> 15) * SinAy >> 15));
    const m11 = i16(((mCosAz * CosAx) >> 15) - (((mSinAz * SinAx) >> 15) * SinAy >> 15));
    const m12 = i16(-((mSinAx * CosAy) >> 15));

    const m20 = i16(((mSinAz * SinAx) >> 15) - (((mCosAz * CosAx) >> 15) * SinAy >> 15));
    const m21 = i16(((mCosAz * SinAx) >> 15) + (((mSinAz * CosAx) >> 15) * SinAy >> 15));
    const m22 = i16((mCosAx * CosAy) >> 15);

    return [[m00, m01, m02], [m10, m11, m12], [m20, m21, m22]];
  }

  _objective(matrix, X, Y, Z) {
    const F = i16(((X * matrix[0][0]) >> 15) + ((Y * matrix[0][1]) >> 15) + ((Z * matrix[0][2]) >> 15));
    const L = i16(((X * matrix[1][0]) >> 15) + ((Y * matrix[1][1]) >> 15) + ((Z * matrix[1][2]) >> 15));
    const U = i16(((X * matrix[2][0]) >> 15) + ((Y * matrix[2][1]) >> 15) + ((Z * matrix[2][2]) >> 15));
    return [F, L, U];
  }

  _subjective(matrix, F, L, U) {
    const X = i16(((F * matrix[0][0]) >> 15) + ((L * matrix[1][0]) >> 15) + ((U * matrix[2][0]) >> 15));
    const Y = i16(((F * matrix[0][1]) >> 15) + ((L * matrix[1][1]) >> 15) + ((U * matrix[2][1]) >> 15));
    const Z = i16(((F * matrix[0][2]) >> 15) + ((L * matrix[1][2]) >> 15) + ((U * matrix[2][2]) >> 15));
    return [X, Y, Z];
  }

  _scalarProject(matrix, X, Y, Z) {
    return i16((X * matrix[0][0] + Y * matrix[0][1] + Z * matrix[0][2]) >> 15);
  }

  _polarRotate(angZ, angY, angX, xbr0, ybr0, zbr0) {
    const sinZ = dspSin(angZ), cosZ = dspCos(angZ);
    const sinY = dspSin(angY), cosY = dspCos(angY);
    const sinX = dspSin(angX), cosX = dspCos(angX);

    // Rotate around Z
    let x1 = i16(((ybr0 * sinZ) >> 15) + ((xbr0 * cosZ) >> 15));
    let y1 = i16(((ybr0 * cosZ) >> 15) - ((xbr0 * sinZ) >> 15));
    let xbr = x1, ybr = y1, zbr = zbr0;

    // Rotate around Y
    let z1 = i16(((xbr * sinY) >> 15) + ((zbr * cosY) >> 15));
    x1 = i16(((xbr * cosY) >> 15) - ((zbr * sinY) >> 15));
    const xar = x1;
    zbr = z1;

    // Rotate around X
    y1 = i16(((zbr * sinX) >> 15) + ((ybr * cosX) >> 15));
    z1 = i16(((zbr * cosX) >> 15) - ((ybr * sinX) >> 15));
    const yar = y1;
    const zar = z1;

    this.Op1CXBR = xbr;
    this.Op1CYBR = ybr;
    this.Op1CZBR = zbr;

    return [xar, yar, zar];
  }

  _rotationCorrection(Zr, Xr, Yr, U, F, L) {
    const cosXr = dspCos(Xr);
    const sinXr = dspSin(Xr);
    const cosYr = dspCos(Yr);
    const sinYr = dspSin(Yr);

    let [CSec, ESec] = dspInverse(cosXr, 0);

    // Rotation around Z
    let [C, E] = dspNormalizeDouble(U * cosYr - F * sinYr);
    E = i16(ESec - E);
    [C, E] = dspNormalize(i16((C * CSec) >> 15), E);
    const Zrr = i16(Zr + dspTruncate(C, E));

    // Rotation around X
    const Xrr = i16(Xr + ((U * sinYr) >> 15) + ((F * cosYr) >> 15));

    // Rotation around Y
    [C, E] = dspNormalizeDouble(U * cosYr + F * sinYr);
    E = i16(ESec - E);
    let CSin;
    [CSin, E] = dspNormalize(sinXr, E);
    const CTan = i16((CSec * CSin) >> 15);
    [C, E] = dspNormalize(i16(-((C * CTan) >> 15)), E);
    const Yrr = i16(Yr + dspTruncate(C, E) + L);

    return [Zrr, Xrr, Yrr];
  }
}

exports.DSP1 = DSP1;

};

registry['SNES'] = function(module,exports,require) {
const CPU = require('./CPU').CPU;
const PPU = require('./PPU').PPU;
const APU = require('./APU').APU;
const MMU = require('./MMU').MMU;




class SNES {
  constructor() {
    this.mmu = new MMU();
    this.cpu = new CPU(this.mmu);
    this.ppu = new PPU();
    this.apu = new APU();

    // Connect components
    this.mmu.connectPPU(this.ppu);
    this.mmu.connectAPU(this.apu);
  }

  loadRom(buffer) {
    this.mmu.loadRom(buffer);
    this.reset();
  }

  reset() {
    if (this.apu) this.apu.reset(); // Reset APU FIRST
    if (this.ppu) this.ppu.reset();
    this.cpu.reset(); // Then CPU starts execution
    this.scanlineDebt = 0;
    this.apuTargetCycles = this.apu.cycles;

        // Register core components globally for diagnostics
    globalThis._snesMMU = this.mmu;
    globalThis._snesPPU = this.ppu;
  }

  getAudioSamples() {
      if (!this.apu || !this.apu.dsp) return null;
      const dsp = this.apu.dsp;
      const length = dsp.samplePos;
      if (length === 0) return null;

      const left = new Float32Array(dsp.sampleBufferL.buffer, 0, length);
      const right = new Float32Array(dsp.sampleBufferR.buffer, 0, length);

      // Make copies so DSP can keep writing
      const lCopy = new Float32Array(left);
      const rCopy = new Float32Array(right);

      dsp.samplePos = 0;
      return { left: lCopy, right: rCopy };
  }

  frame() {
    if (this.frameCount === undefined) this.frameCount = 0;
    this.frameCount++;
    globalThis._snesFrame = this.frameCount;
    globalThis._snesCPU = this.cpu;
    const scanlinesPerFrame = 262;
    const cyclesPerScanline = Math.floor(1364 / 6); // ~227: SNES CPU ~3.58MHz, 1364 master clocks/line

    // Total simplified frame loop
    for (let line = 0; line < scanlinesPerFrame; line++) { this.line = line; globalThis._snesScanline = line;
        // VBlank Start (Line 225)
        if (line === 225) {
            this.mmu.rdnmi |= 0x80; // Set VBlank Flag
            // Hardware resets OAM internal address to the value in $2102/$2103 at VBlank start
            if (this.ppu) {
                this.ppu.oamAddr = ((this.ppu.oamaddh & 1) << 8) | this.ppu.oamaddl;
                this.ppu.oamFlip = 0;
            }
            if (this.mmu.nmitimen & 0x80) { // NMI Enabled
                this.cpu.nmiPending = true;
                if (this.frameCount <= 600 && this.frameCount % 60 === 0) {
                    console.log(`[NMI] Frame ${this.frameCount}: NMI fired, PC=${this.cpu.PB.toString(16).padStart(2,'0')}:${this.cpu.PC.toString(16).padStart(4,'0')} INIDISP=${this.ppu.inidisp.toString(16)}`);
                }
            }
        }

        // Clear VBlank bit at Line 0
        if (line === 0) {
            this.mmu.rdnmi &= 0x7F; // Clear VBlank Flag
            this.ppu.field = (this.ppu.field + 1) & 1; // Toggle field
            if (this.mmu.hdmaen) this.mmu.initHDMA();
        }

        // Update HVBJOY ($4212)
        // Bit 7: VBlank, Bit 0: Auto-Joypad Status
        let hvbjoy = 0;
        if (line >= 225) hvbjoy |= 0x80;

        // Auto-Joypad Reading (Scanlines 225-227 roughly)
        // Always copy at VBlank so it's ready, actual hardware delays it 3 scanlines
        if (line === 225) {
            hvbjoy |= 1;
        }
        if (line >= 225 && line <= 227 && (this.mmu.nmitimen & 1)) {
            hvbjoy |= 1; // Busy
            // Actually perform the read at start of 225
            if (line === 225) {
                // Copy joypad states to auto registers $4218-$421F
                // Joy1 (16 bits) -> 4218, 4219
                const j1 = this.mmu.joy1;
                this.mmu.autoJoy[0] = j1 & 0xFF;          // $4218 = lo byte (A,X,L,R,0,0,0,0)
                this.mmu.autoJoy[1] = (j1 >> 8) & 0xFF;   // $4219 = hi byte (B,Y,sel,start,Up,Down,Left,Right)
                // Joy2
                const j2 = this.mmu.joy2;
                this.mmu.autoJoy[2] = j2 & 0xFF;
                this.mmu.autoJoy[3] = (j2 >> 8) & 0xFF;
                // Joy3/4 (if multitap) - assume 0
                this.mmu.autoJoy[4] = 0;
                this.mmu.autoJoy[5] = 0;
                this.mmu.autoJoy[6] = 0;
                this.mmu.autoJoy[7] = 0;
            }
        }

        // Execute CPU instructions for one scanline duration
        let lineCycles = this.scanlineDebt;
        let irqFired = false;
        const irqMode = this.mmu.nmitimen & 0x30;

        while (lineCycles < cyclesPerScanline) {
            // Check IRQ
            if (!irqFired && irqMode) {
                const dots = lineCycles * 1.5;
                if (irqMode === 0x30) {
                    if (line === this.mmu.vtime && dots >= this.mmu.htime) {
                        this.mmu.timeUp = true;
                        this.cpu.irqPending = true;
                        irqFired = true;
                    }
                } else if (irqMode === 0x20) {
                    if (line === this.mmu.vtime && dots >= 0) { // Fires early on line
                        this.mmu.timeUp = true;
                        this.cpu.irqPending = true;
                        irqFired = true;
                    }
                } else if (irqMode === 0x10) {
                    if (dots >= this.mmu.htime) {
                        this.mmu.timeUp = true;
                        this.cpu.irqPending = true;
                        irqFired = true;
                    }
                }
            }

            // HBlank starts around cycle 1096 of 1364 (137 of 170)
            if (lineCycles >= 137) {
                if (this.ppu) this.ppu.hvbjoy = hvbjoy | 0x40; // Set HBlank
            } else {
                if (this.ppu) this.ppu.hvbjoy = hvbjoy & ~0x40; // Clear HBlank
            }
            const cyclesTaken = this.cpu.step();
            lineCycles += cyclesTaken;

            if (this.apu) {
                if (this.apuTargetCycles === undefined) {
                    this.apuTargetCycles = this.apu.cycles;
                }
                this.apuTargetCycles += cyclesTaken * 1024 / 3580;
                while (this.apu.cycles < this.apuTargetCycles) this.apu.step();
            }

            if (this.ppu) {
                this.ppu.vcounter = line;
                this.ppu.hcounter = Math.floor(lineCycles * (1364 / cyclesPerScanline));
            }
        }

        // Carry instruction cycles past the scanline boundary into the next line.
        this.scanlineDebt = lineCycles - cyclesPerScanline;

        // Render visible lines
        if (line < 224) {
            this.ppu.renderLine(line);
        }

        // Emulate HDMA at H-blank (fires after active pixels, takes effect for next line)
        if (line < 225 && this.mmu.hdmaen) {
            this.mmu.doHDMA();
        }
    }

    // Debug: track WRAM[$9A] (CGADSUB shadow) changes near triforce scene
    const w9a = this.mmu.wram[0x9a];
    if (this._prev9A === undefined) this._prev9A = w9a;
    if (w9a !== this._prev9A) {
        // console.log(`[Frame ${this.frameCount}] $9A changed: ...`);
        this._prev9A = w9a;
    }
  }
}

exports.SNES = SNES;

};
module.exports = load('SNES');
})();
