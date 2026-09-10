'use strict';

// Standing conditions the operator should see, and the four that are genuinely alarming.
//
// The alarm list is deliberately short. An app that raises a banner for every warning trains people
// to dismiss banners, and the four below are the ones where money is actually at stake and where
// the status API has nothing to say -- they exist only as daemon log lines.

const crypto = require('crypto');

const ALARMS = [
  {
    kind: 'loss',
    level: 'error',
    re: /Submarine swap: LOSS\./,
    message: 'A swap lost money. The invoice was paid but the counterparty\'s refund confirmed ' +
      'before this node\'s claim did.',
    remedy: 'Check the timeout and claim-window settings before serving more submarine swaps.',
  },
  {
    kind: 'loss-risk',
    level: 'error',
    re: /Submarine swap: LOSS RISK\./,
    message: 'A swap may be about to lose money. The invoice was paid and the claim has not ' +
      'confirmed, so the counterparty can now refund.',
    remedy: 'A higher on-chain fee rate makes future claims confirm faster. It will not help this one.',
  },
  {
    kind: 'persist',
    level: 'error',
    re: /FAILED TO PERSIST/,
    message: 'A swap could not be written to disk, so it will not be resumed after a restart. If ' +
      'it is funded, its refund depends on this app staying up.',
    remedy: 'Do not restart this app until that swap finishes, then check the disk.',
  },
  {
    // The only one that clears itself: it is a backend outage, and requiring a click to dismiss a
    // self-healing condition is exactly how an alarm list stops being read.
    kind: 'reorg-blind',
    level: 'warn',
    re: /reorg detection has failed \d+ times in a row/,
    message: 'Reorg detection is not working. Swaps keep running, but a chain reorganisation ' +
      'affecting one would go unnoticed.',
    remedy: null,
    clearsOn: /chain reorg detected at height|reorg detection recovered/,
    autoClear: true,
  },
];

class Notices {
  constructor() {
    this.items = new Map();
  }

  raise({ level = 'warn', code, message, remedy = null, sticky = false, detail = null }) {
    const key = code || crypto.randomUUID();
    const existing = this.items.get(key);
    this.items.set(key, {
      code: key,
      level,
      message,
      remedy,
      detail: detail || (existing && existing.detail) || null,
      sticky,
      at_unix: existing ? existing.at_unix : Math.floor(Date.now() / 1000),
      acknowledged: false,
    });
    return key;
  }

  clear(code) { this.items.delete(code); }
  acknowledge(code) {
    const item = this.items.get(code);
    if (!item) return false;
    if (item.sticky) { item.acknowledged = true; return true; }
    this.items.delete(code);
    return true;
  }

  /** Scan a batch of freshly ingested log lines for the four alarm conditions. */
  scan(lines) {
    for (const line of lines) {
      for (const alarm of ALARMS) {
        if (alarm.clearsOn && alarm.clearsOn.test(line.message)) this.clear(alarm.kind);
        if (!alarm.re.test(line.message)) continue;
        this.raise({
          code: alarm.kind,
          level: alarm.level,
          message: alarm.message,
          // The daemon's own sentence, kept verbatim: it names the txid and the heights, which is
          // the part an operator actually needs.
          detail: line.message,
          remedy: alarm.remedy,
          sticky: !alarm.autoClear,
        });
      }
    }
  }

  list() {
    return [...this.items.values()]
      .filter((n) => !n.acknowledged)
      .sort((a, b) => (a.level === b.level ? b.at_unix - a.at_unix : a.level === 'error' ? -1 : 1));
  }
}

module.exports = { Notices, ALARMS };
