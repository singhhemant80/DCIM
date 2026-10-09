import { Injectable } from '@nestjs/common';
import { generateSecret, generateURI, verify } from 'otplib';
import QRCode from 'qrcode';

/**
 * RFC 6238 TOTP (SHA-1, 6 digits, 30 s) — the parameters every mainstream
 * authenticator app supports. Verification accepts one step of clock skew in
 * the past and rejects any time step at or before the last accepted one
 * (replay protection).
 */
@Injectable()
export class MfaService {
  newSecret(): string {
    return generateSecret(); // 20 random bytes, Base32
  }

  async provisioning(secret: string, accountLabel: string, issuer: string) {
    const uri = generateURI({ issuer, label: accountLabel, secret });
    const qrDataUrl = await QRCode.toDataURL(uri, { errorCorrectionLevel: 'M', margin: 1, width: 220 });
    return { uri, qrDataUrl };
  }

  /** Returns the accepted time step, or null if the code is invalid or replayed. */
  async verifyCode(secret: string, code: string, lastTimeStep: number | null): Promise<number | null> {
    try {
      const result = await verify({
        secret,
        token: code,
        epochTolerance: [30, 0],
        ...(lastTimeStep !== null ? { afterTimeStep: lastTimeStep } : {}),
      });
      // The unified verify() result type also covers HOTP; TOTP results carry the matched time step.
      return result.valid && 'timeStep' in result && typeof result.timeStep === 'number' ? result.timeStep : null;
    } catch {
      // otplib throws on malformed input or an out-of-range afterTimeStep — both are "invalid".
      return null;
    }
  }
}
