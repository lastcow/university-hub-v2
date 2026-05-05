// LMS provider registry unit tests (sub-issue UNI-51).
//
// The registry ships empty in this issue. The tests cover the
// behavioral surface — register / get / require / ids — using a
// minimal fake provider so the substrate compiles end-to-end and
// future provider implementations have a worked example of the
// interface they must satisfy.

import { describe, expect, it } from "vitest";

import type {
  LmsAuthCredentials,
  LmsConnection,
  LmsCourse,
  LmsEnrollment,
  LmsProviderConfig,
  LmsProviderId,
  LmsTerm,
} from "@university-hub/shared";

import type { LmsProvider } from "../../src/lms/provider.js";
import {
  LmsProviderRegistry,
  lmsProviderRegistry,
} from "../../src/lms/registry.js";

class FakeProvider implements LmsProvider {
  readonly id: LmsProviderId;

  constructor(id: LmsProviderId) {
    this.id = id;
  }

  async authenticate(
    _creds: LmsAuthCredentials,
    _config: LmsProviderConfig,
  ): Promise<LmsConnection> {
    throw new Error("not implemented in fake");
  }
  async refreshToken(connection: LmsConnection): Promise<LmsConnection> {
    return connection;
  }
  async listTerms(_c: LmsConnection): Promise<LmsTerm[]> {
    return [];
  }
  async listMyCourses(
    _c: LmsConnection,
    _termId: string,
  ): Promise<LmsCourse[]> {
    return [];
  }
  async listEnrollments(
    _c: LmsConnection,
    _courseId: string,
  ): Promise<LmsEnrollment[]> {
    return [];
  }
}

describe("LmsProviderRegistry", () => {
  it("starts empty", () => {
    const registry = new LmsProviderRegistry();
    expect(registry.ids()).toEqual([]);
    expect(registry.get("canvas")).toBeUndefined();
  });

  it("registers and retrieves a provider by id", () => {
    const registry = new LmsProviderRegistry();
    const canvas = new FakeProvider("canvas");
    registry.register(canvas);
    expect(registry.get("canvas")).toBe(canvas);
    expect(registry.ids()).toEqual(["canvas"]);
  });

  it("re-registering the same id replaces the prior implementation", () => {
    const registry = new LmsProviderRegistry();
    const first = new FakeProvider("canvas");
    const second = new FakeProvider("canvas");
    registry.register(first);
    registry.register(second);
    expect(registry.get("canvas")).toBe(second);
    expect(registry.ids()).toEqual(["canvas"]);
  });

  it("require throws for unregistered providers", () => {
    const registry = new LmsProviderRegistry();
    expect(() => registry.require("blackboard")).toThrow(
      /'blackboard' is not registered/,
    );
  });

  it("require returns the registered implementation", () => {
    const registry = new LmsProviderRegistry();
    const moodle = new FakeProvider("moodle");
    registry.register(moodle);
    expect(registry.require("moodle")).toBe(moodle);
  });

  it("the process-wide registry has Canvas registered after the canvas module is imported (UNI-52)", async () => {
    // Side-effect import populates the singleton. The substrate test
    // (UNI-51) asserted the registry was empty; UNI-52 wires Canvas.
    await import("../../src/lms/canvas/index.js");
    expect(lmsProviderRegistry.ids()).toContain("canvas");
    expect(lmsProviderRegistry.require("canvas").id).toBe("canvas");
  });
});
