import { Injectable, OnModuleDestroy, ServiceUnavailableException } from "@nestjs/common";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private instance?: PrismaClient;

  client(): PrismaClient {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new ServiceUnavailableException("Database is not configured.");
    }
    this.instance ??= new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
    return this.instance;
  }

  async onModuleDestroy() {
    await this.instance?.$disconnect();
  }
}
