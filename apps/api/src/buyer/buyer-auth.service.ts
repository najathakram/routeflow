import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import * as bcrypt from "bcrypt";
import * as crypto from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { AppConfig } from "../config/configuration";
import { BuyerJwtPayload } from "./interfaces/buyer-jwt-payload.interface";
import { BuyerRegisterDto } from "./dto/buyer-register.dto";
import { BuyerLoginDto } from "./dto/buyer-login.dto";

@Injectable()
export class BuyerAuthService {
  private readonly logger = new Logger(BuyerAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService<AppConfig>,
  ) {}

  // ─── Register ─────────────────────────────────────────────────────────────────

  async register(dto: BuyerRegisterDto) {
    const existing = await this.prisma.buyerAccount.findUnique({
      where: { email: dto.email.toLowerCase() },
    });
    if (existing && !existing.deletedAt) {
      throw new ConflictException("An account with this email already exists");
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const account = await this.prisma.buyerAccount.create({
      data: {
        email: dto.email.toLowerCase(),
        passwordHash,
        name: dto.name,
        phone: dto.phone,
        mobile: dto.mobile,
        status: "ACTIVE",
        emailVerified: false,
      },
    });

    const tokens = await this.issueBuyerTokenPair(account.id, account.email, account.name);
    this.logger.log(`BuyerAccount registered: ${account.email}`);

    return {
      ...tokens,
      buyer: { id: account.id, email: account.email, name: account.name },
    };
  }

  // ─── Login ────────────────────────────────────────────────────────────────────

  async login(dto: BuyerLoginDto) {
    const account = await this.prisma.buyerAccount.findUnique({
      where: { email: dto.email.toLowerCase() },
    });

    if (!account || account.deletedAt) {
      throw new UnauthorizedException("Invalid credentials");
    }
    if (account.status === "SUSPENDED") {
      throw new UnauthorizedException("This account has been suspended");
    }
    if (account.status === "DELETED") {
      throw new UnauthorizedException("Invalid credentials");
    }

    const valid = await bcrypt.compare(dto.password, account.passwordHash);
    if (!valid) throw new UnauthorizedException("Invalid credentials");

    const tokens = await this.issueBuyerTokenPair(account.id, account.email, account.name);

    return {
      ...tokens,
      buyer: { id: account.id, email: account.email, name: account.name },
    };
  }

  // ─── Refresh ──────────────────────────────────────────────────────────────────

  async refresh(incomingToken: string) {
    const jwtConfig = this.configService.get<AppConfig["jwt"]>("jwt")!;

    let payload: { sub: string };
    try {
      payload = this.jwtService.verify(incomingToken, {
        secret: jwtConfig.refreshSecret,
      });
    } catch {
      throw new UnauthorizedException("Invalid or expired refresh token");
    }

    const tokenHash = this.hashToken(incomingToken);
    const stored = await this.prisma.buyerRefreshToken.findUnique({ where: { tokenHash } });

    if (!stored || stored.buyerAccountId !== payload.sub || stored.expiresAt < new Date()) {
      throw new UnauthorizedException("Refresh token revoked or expired");
    }

    // Rotate — delete old, issue new pair
    await this.prisma.buyerRefreshToken.deleteMany({ where: { tokenHash } });

    const account = await this.prisma.buyerAccount.findUnique({ where: { id: payload.sub } });
    if (!account || account.status !== "ACTIVE" || account.deletedAt) {
      throw new UnauthorizedException("Account unavailable");
    }

    const tokens = await this.issueBuyerTokenPair(account.id, account.email, account.name);
    return {
      ...tokens,
      buyer: { id: account.id, email: account.email, name: account.name },
    };
  }

  // ─── Logout ───────────────────────────────────────────────────────────────────

  async logout(buyerAccountId: string) {
    await this.prisma.buyerRefreshToken.deleteMany({ where: { buyerAccountId } });
    return { message: "Logged out successfully" };
  }

  // ─── Delete account ───────────────────────────────────────────────────────────

  async deleteAccount(buyerAccountId: string) {
    // Soft delete account
    await this.prisma.buyerAccount.update({
      where: { id: buyerAccountId },
      data: { status: "DELETED", deletedAt: new Date() },
    });

    // Disconnect all active/pending links
    await this.prisma.customerLink.updateMany({
      where: {
        buyerAccountId,
        status: { notIn: ["DISCONNECTED"] },
      },
      data: {
        status: "DISCONNECTED",
        disconnectedBy: "BUYER",
        disconnectedAt: new Date(),
      },
    });

    // Revoke all refresh tokens
    await this.prisma.buyerRefreshToken.deleteMany({ where: { buyerAccountId } });

    this.logger.log(`BuyerAccount soft-deleted: ${buyerAccountId}`);
    return { message: "Account deleted. All seller connections have been removed." };
  }

  // ─── Change password ──────────────────────────────────────────────────────────

  async changePassword(buyerAccountId: string, currentPassword: string, newPassword: string) {
    const account = await this.prisma.buyerAccount.findUnique({ where: { id: buyerAccountId } });
    if (!account) throw new UnauthorizedException();

    const valid = await bcrypt.compare(currentPassword, account.passwordHash);
    if (!valid) throw new BadRequestException("Current password is incorrect");

    const sameAsOld = await bcrypt.compare(newPassword, account.passwordHash);
    if (sameAsOld) throw new BadRequestException("New password must differ from current password");

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await this.prisma.buyerAccount.update({
      where: { id: buyerAccountId },
      data: { passwordHash },
    });

    // Revoke all refresh tokens on password change
    await this.prisma.buyerRefreshToken.deleteMany({ where: { buyerAccountId } });

    return { message: "Password changed successfully" };
  }

  // ─── Get profile ──────────────────────────────────────────────────────────────

  async getProfile(buyerAccountId: string) {
    const account = await this.prisma.buyerAccount.findUnique({
      where: { id: buyerAccountId },
      select: { id: true, email: true, name: true, phone: true, mobile: true, emailVerified: true, createdAt: true },
    });
    if (!account) throw new UnauthorizedException();
    return account;
  }

  async updateProfile(buyerAccountId: string, dto: { name?: string; phone?: string; mobile?: string }) {
    return this.prisma.buyerAccount.update({
      where: { id: buyerAccountId },
      data: dto,
      select: { id: true, email: true, name: true, phone: true, mobile: true, emailVerified: true },
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  private hashToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  private async storeBuyerRefreshToken(buyerAccountId: string, token: string) {
    const tokenHash = this.hashToken(token);
    const decoded = this.jwtService.decode(token) as { exp: number };
    const expiresAt = new Date(decoded.exp * 1000);
    await this.prisma.buyerRefreshToken.upsert({
      where: { tokenHash },
      create: { buyerAccountId, tokenHash, expiresAt },
      update: { expiresAt },
    });
  }

  async issueBuyerTokenPair(buyerAccountId: string, email: string, name: string = "") {
    const jwtConfig = this.configService.get<AppConfig["jwt"]>("jwt")!;

    const payload: BuyerJwtPayload = { sub: buyerAccountId, email, name, type: "BUYER" };

    const accessToken = this.jwtService.sign(payload, {
      secret: jwtConfig.secret,
      expiresIn: jwtConfig.expiresIn as any,
    });

    const refreshToken = this.jwtService.sign(
      { sub: buyerAccountId },
      { secret: jwtConfig.refreshSecret, expiresIn: jwtConfig.refreshExpiresIn as any },
    );

    await this.storeBuyerRefreshToken(buyerAccountId, refreshToken);

    return { accessToken, refreshToken };
  }
}
