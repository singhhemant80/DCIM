import { describe, expect, it } from 'vitest';
import { parseRouterOsHealth } from './routeros';
import { HEALTH_OID, OID, parseSnmpHealth } from './snmp';

describe('device health parsing', () => {
  it('RouterOS v7: resource plus the sensor list', () => {
    const h = parseRouterOsHealth(
      { 'cpu-load': '17', 'cpu-count': '4', 'free-memory': '536870912', 'total-memory': '1073741824', 'free-hdd-space': '0', 'total-hdd-space': '134217728', uptime: '1d02:00:00', version: '7.16.1 (stable)', 'board-name': 'CCR2116-12G-4S+' },
      [
        { name: 'voltage', value: '24.1', type: 'V' },
        { name: 'temperature', value: '41', type: 'C' },
        { name: 'cpu-temperature', value: '55', type: 'C' },
        { name: 'fan1-speed', value: '4100', type: 'RPM' },
        { name: 'psu1-state', value: 'ok', type: '' },
        { name: 'power-consumption', value: '38.5', type: 'W' },
      ],
    );
    expect(h).toMatchObject({ cpuPct: 17, cpuCount: 4, memoryUsedBytes: 536870912, memoryTotalBytes: 1073741824, diskUsedBytes: 134217728, temperatureC: 41, cpuTemperatureC: 55, voltage: 24.1, uptimeSeconds: 93600, version: '7.16.1 (stable)', board: 'CCR2116-12G-4S+' });
    expect(h.sensors.map((x) => x.name)).toEqual(['fan1-speed', 'psu1-state']);
  });

  it('RouterOS v6 (one object) and a CHR without sensors', () => {
    expect(parseRouterOsHealth({ 'cpu-load': '2' }, { voltage: '12.0', temperature: '35' })).toMatchObject({ cpuPct: 2, voltage: 12, temperatureC: 35 });
    expect(parseRouterOsHealth({ 'cpu-load': '1', 'total-memory': '1000' }, null)).toMatchObject({ cpuPct: 1, temperatureC: null, memoryUsedBytes: null, sensors: [] });
  });

  it('SNMP: average processor load, RAM and disk from hrStorage, MikroTik sensors in tenths', () => {
    const sys = new Map([[OID.sysUpTime, 360000]]);
    const load = new Map([[2, new Map([['1', 10], ['2', 30]])]]);
    const storage = new Map([
      [2, new Map([['65536', HEALTH_OID.hrStorageRam], ['131072', HEALTH_OID.hrStorageFixedDisk], ['3', '1.3.6.1.2.1.25.2.1.1']])],
      [4, new Map([['65536', 1024], ['131072', 1024], ['3', 1]])],
      [5, new Map([['65536', 1048576], ['131072', 131072], ['3', 5]])],
      [6, new Map([['65536', 262144], ['131072', 65536], ['3', 1]])],
    ]);
    const mt = new Map([[HEALTH_OID.mtxrHlTemperature, 415], [HEALTH_OID.mtxrHlVoltage, 241]]);
    const h = parseSnmpHealth(sys, load as never, storage as never, mt);
    expect(h).toMatchObject({ cpuPct: 20, cpuCount: 2, memoryTotalBytes: 1073741824, memoryUsedBytes: 268435456, diskTotalBytes: 134217728, diskUsedBytes: 67108864, temperatureC: 41.5, voltage: 24.1, uptimeSeconds: 3600 });
  });
});
