'use strict';
let Focas, ALLAXIS;
try {
    const m = require('./focas');
    Focas   = m.Focas;
    ALLAXIS = m.ALLAXIS;
    if (typeof Focas !== 'function') {
        throw new Error(
            `focas.js exported Focas as '${typeof Focas}' (expected a class). ` +
            `Ensure focas.js is in the same directory as fanuc-focas.js.`
        );
    }
} catch (e) {
    throw new Error(`node-red-contrib-fanuc-focas: failed to load focas.js — ${e.message}`);
}


// ── Lookup tables ─────────────────────────────────────────────────────────────
const AUT_MODES = {
    0:'MDI', 1:'MEMory', 2:'****', 3:'EDIT', 4:'HaNDle',
    5:'JOG', 6:'Teach in JOG', 7:'Teach in HaNDle',
    8:'INC feed', 9:'REFerence', 10:'ReMoTe',
};
const RUN_MODES_16 = { 0:'****', 1:'STOP', 2:'HOLD', 3:'STaRt', 4:'MSTR' };
const RUN_MODES_15 = {
    0:'STOP', 1:'HOLD', 2:'STaRt', 3:'MSTR', 4:'ReSTaRt',
    5:'PRSR', 6:'NSRC', 7:'ReSTaRt*', 8:'ReSET', 13:'HPCC',
};
const EMG_STATES = { 0:null, 1:'EMERGENCY', 2:'RESET', 3:'WAIT' };
const ALM_STATES = {
    0:null, 1:'ALARM', 2:'BATTERY LOW', 3:'FAN',
    4:'PS WARNING', 5:'FSSB WARNING', 6:'INSULATE WARNING',
    7:'ENCODER WARNING', 8:'PMC ALARM',
};
const ALARM_TYPES = {
    0:'BG', 1:'TH', 2:'RS', 4:'SV', 8:'SW',
    16:'IO', 32:'PS', 64:'OT', 128:'OH',
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function readParamVal(paramMap, key) {
    return (paramMap && paramMap[key]) ? paramMap[key].data[0] : null;
}

function buildTimer(minVal, msVal = null) {
    if (minVal === null || minVal === undefined)
        return { total_seconds: null, formatted: null };
    const ms       = (msVal !== null && msVal !== undefined) ? msVal : 0;
    const totalSec = minVal * 60 + ms / 1000;
    const h        = Math.floor(totalSec / 3600);
    const rem      = Math.floor(totalSec % 3600);
    const m        = Math.floor(rem / 60);
    const s        = Math.floor(rem % 60);
    const frac     = Math.round(totalSec * 1000) % 1000;
    const formatted = msVal !== null
        ? `${h}h ${String(m).padStart(2,'0')}m ${String(s).padStart(2,'0')}.${String(frac).padStart(3,'0')}s`
        : `${h}h ${String(m).padStart(2,'0')}m`;
    return { total_seconds: Math.round(totalSec * 1000) / 1000, formatted };
}

// ── Function implementations ──────────────────────────────────────────────────

async function fnStatusInfo(focas, runModes) {
    const state = await focas.statinfo();
    if (!state) return null;
    return {
        mode:      state.aut in AUT_MODES ? AUT_MODES[state.aut] : String(state.aut),
        run_state: state.run in runModes ? runModes[state.run] : String(state.run),
        motion:    state.motion ? 'Moving' : 'Stopped',
        mstb:      state.mstb   ? 'Active' : 'Inactive',
        emergency: (state.emegency in EMG_STATES) ? EMG_STATES[state.emegency] : `UNKNOWN(${state.emegency})`,
        alarm:     (state.alarm    in ALM_STATES) ? ALM_STATES[state.alarm]    : `ALARM(${state.alarm})`,
        edit:      state.edit   ? 'Active' : 'Inactive',
    };
}

async function fnSystemInfo(focas) {
    const si = focas.sysinfo;
    return {
        cnc_type: si.cnctype.trim(),
        mt_type:  si.mttype.trim(),
        series:   si.series.trim(),
        version:  si.version.trim(),
        axes:     si.maxaxis,
    };
}

async function fnTimers(focas) {
    // FOCAS is strictly sequential — no Promise.all on a single socket
    const p6750 = await focas.readparam3(ALLAXIS, 6750);
    const p6751 = await focas.readparam3(ALLAXIS, 6751);
    const p6752 = await focas.readparam3(ALLAXIS, 6752);
    const p6753 = await focas.readparam3(ALLAXIS, 6753);
    const p6754 = await focas.readparam3(ALLAXIS, 6754);
    const p6757 = await focas.readparam3(ALLAXIS, 6757);
    const p6758 = await focas.readparam3(ALLAXIS, 6758);
    return {
        power_on_time:       buildTimer(readParamVal(p6750, 6750)),
        auto_operation_time: buildTimer(readParamVal(p6752, 6752), readParamVal(p6751, 6751)),
        cutting_time:        buildTimer(readParamVal(p6754, 6754), readParamVal(p6753, 6753)),
        cycle_time:          buildTimer(readParamVal(p6758, 6758), readParamVal(p6757, 6757)),
    };
}

async function fnProgramNumber(focas) {
    const prognum = await focas.readprognum();
    if (!prognum) return null;
    const runNum   = prognum.run;
    const mainNum  = prognum.main;
    const progList = await focas.listprog(Math.min(runNum, mainNum));
    const cmt = (n) => (progList && progList[n]) ? (progList[n].comment.trim() || null) : null;
    return {
        running_program:  `O${runNum}`,
        main_program:     `O${mainNum}`,
        running_comment:  cmt(runNum),
        main_comment:     cmt(mainNum),
    };
}

async function fnPartCount(focas) {
    const p6711 = await focas.readparam3(ALLAXIS, 6711);
    const p6712 = await focas.readparam3(ALLAXIS, 6712);
    return {
        required_parts:  readParamVal(p6711, 6711),
        lifetime_total:  readParamVal(p6712, 6712),
    };
}

async function fnAlarmMessages(focas) {
    const alarms = await focas.readalarmcode(1, 1, 10, 32);
    return (alarms || []).map(a => ({
        type: a.alarmtype in ALARM_TYPES ? ALARM_TYPES[a.alarmtype] : String(a.alarmtype),
        code: a.alarmcode,
        axis: a.axis,
        text: a.text,
    }));
}

async function fnAxesData(focas, axisType) {
    // axisType maps to the what bitmask used in readaxes()
    // Implemented directly via _reqSingle for the data types we need
    switch (axisType) {
        case 'feedrate':
            return { actual_feedrate_mm_min: await focas.readactfeed() };
        case 'spindle_speed':
            return { actual_spindle_rpm: await focas.readactspindlespeed() };
        case 'spindle_load':
            return { spindle_load_percent: await focas.readspindleload() };
        case 'servo_load':
            return { servo_load_percent: await focas.readservoload() };
        case 'abs_pos':
            return { absolute_position: await focas.readaxes(1) };
        case 'rel_pos':
            return { relative_position: await focas.readaxes(2) };
        case 'dist_to_go':
            return { distance_to_go: await focas.readaxes(16) };
        case 'machine_pos':
            return { machine_position: await focas.readaxes(4) };
        default:
            return null;
    }
}

async function fnParameters(focas, paramNums) {
    // paramNums is a comma-separated string of parameter numbers
    const nums = String(paramNums).split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
    const result = {};
    for (const n of nums) {
        const r = await focas.readparam3(ALLAXIS, n);
        if (r && r[n]) result[n] = r[n].data[0];
    }
    return result;
}

async function fnMacro(focas, macroNums) {
    const nums = String(macroNums).split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
    const result = {};
    for (const n of nums) {
        const r = await focas.readmacro(n);
        if (r && r[n] !== undefined) result[n] = r[n];
    }
    return result;
}

// ── All-in-one (legacy behaviour) ────────────────────────────────────────────
async function fnAll(focas, runModes) {
    const [status, sysinfo, timers, program, parts, alarms] = [
        await fnStatusInfo(focas, runModes),
        await fnSystemInfo(focas),
        await fnTimers(focas),
        await fnProgramNumber(focas),
        await fnPartCount(focas),
        await fnAlarmMessages(focas),
    ];
    const feed    = await focas.readactfeed();
    const spindle = await focas.readactspindlespeed();
    return {
        controller:       sysinfo,
        machine_state:    status,
        active_program:   program,
        timers,
        part_count:       parts,
        feedrate_spindle: { actual_feedrate_mm_min: feed, actual_spindle_rpm: spindle },
        active_alarms:    alarms,
    };
}

// ── Main dispatcher ───────────────────────────────────────────────────────────
async function collect(ip, port, cnc_series, fn, subtype, params) {
    const focas    = new Focas(ip, port);
    const runModes = cnc_series === '15' ? RUN_MODES_15 : RUN_MODES_16;

    await focas.connect();
    let result;
    try {
        switch (fn) {
            case 'status_info':    result = await fnStatusInfo(focas, runModes);   break;
            case 'system_info':    result = await fnSystemInfo(focas);             break;
            case 'timers':         result = await fnTimers(focas);                 break;
            case 'program_number': result = await fnProgramNumber(focas);          break;
            case 'part_count':     result = await fnPartCount(focas);              break;
            case 'alarm_messages': result = await fnAlarmMessages(focas);          break;
            case 'axes_data':      result = await fnAxesData(focas, subtype);      break;
            case 'parameters':     result = await fnParameters(focas, params);     break;
            case 'macro':          result = await fnMacro(focas, params);          break;
            case 'all':
            default:               result = await fnAll(focas, runModes);          break;
        }
        result = { ...result, timestamp: new Date().toISOString() };
    } finally {
        await focas.disconnect();
    }
    return result;
}

// ── Node-RED registration ─────────────────────────────────────────────────────
module.exports = function(RED) {

    function FanucConfigNode(config) {
        RED.nodes.createNode(this, config);
        this.host       = config.host       || '192.168.0.100';
        this.port       = parseInt(config.port) || 8193;
        this.cnc_series = config.cnc_series || '16';
    }
    RED.nodes.registerType('fanuc-config', FanucConfigNode);

    function FanucFocasNode(config) {
        RED.nodes.createNode(this, config);
        const node   = this;
        const server = RED.nodes.getNode(config.server);

        if (!server) {
            node.error('No FANUC config node selected');
            return;
        }

        node.on('input', async function(msg, send, done) {
            // Allow overriding function/subtype/params via msg
            const fn      = msg.function  || config.fn      || 'all';
            const subtype = msg.subtype   || config.subtype || 'feedrate';
            const params  = msg.params    || config.params  || '';

            node.status({ fill:'blue', shape:'dot', text: fn });
            try {
                msg.payload = await collect(server.host, server.port, server.cnc_series, fn, subtype, params);
                node.status({ fill:'green', shape:'dot', text:'ok' });
                send(msg);
                done();
            } catch (err) {
                node.status({ fill:'red', shape:'ring', text: err.message });
                node.error(err.message, msg);
                done(err);
            }
        });

        node.on('close', () => node.status({}));
    }
    RED.nodes.registerType('fanuc-focas', FanucFocasNode);
};