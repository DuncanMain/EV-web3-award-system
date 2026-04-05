import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
// import { PrismaModule } from './prisma/prisma.module';
import { LoggerModule } from './logger/logger.module';
import { ExceptionHandler } from './exception/exception-handler/exception-handler.module';
// import { UsersModule } from './users/users.module';
// import { RolesModule } from './roles/roles.module';
// import { AuthModule } from './auth/auth.module';
// import { FilesModule } from './files/files.module';
import { SpendModule } from './spend/spend.module';
import { WalletModule } from './wallet/wallet.module';
import { IngestModule } from './ingest/ingest.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConsoleLogger } from './logger/console-logger/console-logger';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // PrismaModule,
    LoggerModule,
    ExceptionHandler,
    // UsersModule,
    // RolesModule,
    // AuthModule,
    // FilesModule,
    SpendModule,
    WalletModule,
    IngestModule,
  ],
  controllers: [AppController],
  providers: [AppService, ConsoleLogger],
})
export class AppModule {}
