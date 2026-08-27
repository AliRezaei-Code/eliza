import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  getOrCreateIdentity: vi.fn(),
  createCommand: vi.fn(),
  acknowledgeEnqueue: vi.fn(),
  openResult: vi.fn(),
  openStartReceipt: vi.fn(),
  clearSessionState: vi.fn(),
}));
const nativeAvailable = vi.hoisted(() => ({ value: true }));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => "ios",
    isNativePlatform: () => true,
    isPluginAvailable: () => nativeAvailable.value,
    registerPlugin: () => native,
  },
}));
vi.mock("../bridge/electrobun-rpc", () => ({
  invokeDesktopBridgeRequest: vi.fn(),
}));

import {
  createRemoteCommand,
  getOrCreateRemoteControllerIdentity,
} from "./remote-controller";

describe("Capacitor remote controller bridge", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses native identity storage and never accepts a private key", async () => {
    native.getOrCreateIdentity.mockResolvedValue({
      version: 1,
      role: "controller",
      ownerId: "owner-1",
      deviceId: "iphone-1",
      keyId: "key-1",
      displayName: "My iPhone",
      platform: "ios",
      signingPublicKeyJwk: {
        kty: "EC",
        x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        y: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        crv: "P-256",
      },
      encryptionPublicKeyJwk: {
        kty: "EC",
        x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        y: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        crv: "P-256",
      },
      createdAt: Date.now(),
    });
    const identity = await getOrCreateRemoteControllerIdentity({
      ownerId: "owner-1",
    });
    expect(identity.deviceId).toBe("iphone-1");
    expect(native.getOrCreateIdentity).toHaveBeenCalledWith(
      expect.not.objectContaining({
        privateKey: expect.anything(),
        privateKeyJwk: expect.anything(),
      }),
    );
  });

  it("rejects native output containing private JWK material", async () => {
    native.getOrCreateIdentity.mockResolvedValue({
      version: 1,
      role: "controller",
      ownerId: "other-owner",
      deviceId: "iphone-1",
      keyId: "key-1",
      displayName: "My iPhone",
      platform: "ios",
      signingPublicKeyJwk: {
        kty: "EC",
        x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        y: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        crv: "P-256",
        d: "secret",
      },
      encryptionPublicKeyJwk: {
        kty: "EC",
        x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        y: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        crv: "P-256",
      },
      createdAt: Date.now(),
      privateKeyJwk: { d: "secret" },
    });
    await expect(
      getOrCreateRemoteControllerIdentity({ ownerId: "owner-1" }),
    ).rejects.toThrow("Secure mobile pairing identity is unavailable");
  });

  it("rejects native output for the wrong owner or platform", async () => {
    native.getOrCreateIdentity.mockResolvedValue({
      version: 1,
      role: "controller",
      ownerId: "other-owner",
      deviceId: "iphone-1",
      keyId: "key-1",
      displayName: "My iPhone",
      platform: "android",
      signingPublicKeyJwk: {
        kty: "EC",
        x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        y: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        crv: "P-256",
      },
      encryptionPublicKeyJwk: {
        kty: "EC",
        x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        y: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        crv: "P-256",
      },
      createdAt: Date.now(),
    });
    await expect(
      getOrCreateRemoteControllerIdentity({ ownerId: "owner-1" }),
    ).rejects.toThrow("Secure mobile pairing identity is unavailable");
  });

  it("fails closed when native signing is unavailable", async () => {
    native.createCommand.mockResolvedValue(null);
    await expect(
      createRemoteCommand({
        ownerId: "owner-1",
        grantId: "grant-1",
        grantRevision: 1,
        sessionId: "session-1",
        controller: { deviceId: "iphone-1", keyId: "key-1" } as never,
        target: {
          runtimeId: "mac-1",
          keyId: "target-key",
          encryptionPublicKeyJwk: {},
        } as never,
        action: "observe" as never,
        payload: {},
      }),
    ).rejects.toThrow("Secure mobile command signing is unavailable");
  });

  it("fails closed when the native iOS plugin is absent", async () => {
    nativeAvailable.value = false;
    await expect(
      getOrCreateRemoteControllerIdentity({ ownerId: "owner-1" }),
    ).rejects.toThrow("native iOS plugin is installed");
    nativeAvailable.value = true;
  });
});
