import { describe, it, expect } from 'vitest';
import { createBuildStrategy } from './build-strategy.js';

describe('createBuildStrategy', () => {
  it('enabled=false produces no-op C++ output', () => {
    const strategy = createBuildStrategy({ enabled: false });
    const header = strategy.generateCppHeader();
    expect(header).toContain('/* no-op */');
    expect(header).not.toContain('struct Zone');
  });

  it('enabled=true produces zone logic C++ output', () => {
    const strategy = createBuildStrategy({ enabled: true });
    const header = strategy.generateCppHeader();
    expect(header).toContain('ANATOMIA_ZONE');
    expect(header).toContain('struct');
  });

  it('enabled=false produces no-op C# output', () => {
    const strategy = createBuildStrategy({ enabled: false });
    const stub = strategy.generateCSharpStub();
    // Has the #else branch with no-op body
    expect(stub).toContain('#else');
    expect(stub).toContain('struct Zone');
  });

  it('enabled=true produces IDisposable C# output', () => {
    const strategy = createBuildStrategy({ enabled: true });
    const stub = strategy.generateCSharpStub();
    expect(stub).toContain('IDisposable');
    expect(stub).toContain('struct Zone');
  });

  it('fills in default flag names', () => {
    const strategy = createBuildStrategy({ enabled: true });
    expect(strategy.config.cppFlag).toBe('ANATOMIA_MEASUREMENT_BUILD');
    expect(strategy.config.csharpFlag).toBe('ANATOMIA_MEASUREMENT_BUILD');
  });

  it('preserves custom flag names', () => {
    const strategy = createBuildStrategy({
      enabled: true,
      cppFlag: 'MY_CPP_FLAG',
      csharpFlag: 'MY_CS_FLAG',
    });
    expect(strategy.config.cppFlag).toBe('MY_CPP_FLAG');
    expect(strategy.config.csharpFlag).toBe('MY_CS_FLAG');
  });
});
