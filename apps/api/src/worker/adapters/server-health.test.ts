import { describe, expect, it } from 'vitest';
import { fromDellSensors, healthOf, rollupFromDellSystemView, rollupFromRedfishSystem, temperaturesFromThermal } from './server-health';

describe('server health parsers', () => {
  it('reads health words in any case and nothing else', () => {
    expect([healthOf('OK'), healthOf('Ok'), healthOf('warning'), healthOf('CRITICAL'), healthOf('Unknown'), healthOf(3)]).toEqual(['OK', 'OK', 'Warning', 'Critical', null, null]);
  });

  it('rolls up standard, Dell and HPE fields; the worse one wins', () => {
    expect(
      rollupFromRedfishSystem({
        Status: { Health: 'OK', HealthRollup: 'Warning' },
        ProcessorSummary: { Status: { Health: 'OK', HealthRollup: 'OK' } },
        MemorySummary: { Status: { HealthRollup: 'OK' } },
        Oem: { Dell: { DellSystem: { CPURollupStatus: 'Critical', SysMemPrimaryStatus: 'OK', PSRollupStatus: 'Warning', FanRollupStatus: 'OK', TempRollupStatus: 'OK', StorageRollupStatus: 'Unknown' } } },
      }),
    ).toEqual({ system: 'Warning', cpu: 'Critical', memory: 'OK', psu: 'Warning', fans: 'OK', temperature: 'OK' });
    expect(
      rollupFromRedfishSystem({ Status: { Health: 'OK' }, Oem: { Hpe: { AggregateHealthStatus: { Fans: { Status: { Health: 'OK' } }, PowerSupplies: { Status: { Health: 'Critical' } }, Storage: { Status: { Health: 'Warning' } } } } } }),
    ).toEqual({ system: 'OK', fans: 'OK', psu: 'Critical', storage: 'Warning' });
    expect(rollupFromRedfishSystem({})).toEqual({});
  });

  it('finds inlet, exhaust, CPU and hottest temperatures, skipping absent sensors', () => {
    expect(
      temperaturesFromThermal({
        Temperatures: [
          { Name: 'System Board Inlet Temp', ReadingCelsius: 24 },
          { Name: 'System Board Exhaust Temp', ReadingCelsius: 38 },
          { Name: 'CPU1 Temp', ReadingCelsius: 61 },
          { Name: 'CPU2 Temp', ReadingCelsius: 66 },
          { Name: 'CPU3 Temp', ReadingCelsius: 99, Status: { State: 'Absent' } },
          { Name: 'Broken', ReadingCelsius: null },
        ],
      }),
    ).toEqual({ inletC: 24, exhaustC: 38, cpuTempC: 66, maxTempC: 66 });
    expect(temperaturesFromThermal({})).toEqual({ inletC: null, exhaustC: null, cpuTempC: null, maxTempC: null });
  });

  it('reads Dell CUPS usage and temperatures (with unit modifiers) from WS-Man sensors', () => {
    const s = fromDellSensors([
      { ElementName: 'System Board Inlet Temp', BaseUnits: '2', UnitModifier: '-1', CurrentReading: '230' },
      { ElementName: 'CPU1 Temp', BaseUnits: '2', UnitModifier: '-1', CurrentReading: '610' },
      { ElementName: 'System Board CPU Usage', BaseUnits: '65', UnitModifier: '0', CurrentReading: '37' },
      { ElementName: 'System Board MEM Usage', BaseUnits: '65', UnitModifier: '0', CurrentReading: '12' },
      { ElementName: 'System Board SYS Usage', BaseUnits: '65', UnitModifier: '0', CurrentReading: '250' },
      { ElementName: 'System Board Fan1A', BaseUnits: '19', UnitModifier: '0', CurrentReading: '5040' },
    ]);
    expect(s).toEqual({ cpuUsagePct: 37, memoryUsagePct: 12, ioUsagePct: null, systemUsagePct: null, inletC: 23, exhaustC: null, cpuTempC: 61, maxTempC: 61 });
  });

  it('maps DCIM_SystemView rollups (0 unknown is left out)', () => {
    expect(rollupFromDellSystemView({ PrimaryStatus: '2', CPURollupStatus: '1', PSRollupStatus: '3', FanRollupStatus: '0', TempRollupStatus: null })).toEqual({ system: 'Warning', cpu: 'OK', psu: 'Critical' });
  });
});
