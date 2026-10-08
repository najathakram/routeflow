import { Injectable } from "@nestjs/common";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";

export interface UnitDto {
  id: string;
  name: string;
  archivedAt: string | null;
  productCount: number;
}
export interface UnitUpdateResult {
  unit: UnitDto;
  productsUpdated: number;
}

@Injectable()
export class UnitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(_includeArchived: boolean): Promise<UnitDto[]> {
    throw new Error("not implemented");
  }
  create(_dto: { name: string }, _user: JwtPayload): Promise<UnitDto> {
    throw new Error("not implemented");
  }
  update(
    _id: string,
    _dto: { name?: string; archived?: boolean },
    _user: JwtPayload,
  ): Promise<UnitUpdateResult> {
    throw new Error("not implemented");
  }
}
