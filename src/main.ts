import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ValidationPipe } from '@nestjs/common';
// import { AccessTokenGuard } from './auth/guards/accessToken.guard';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const configService = app.get(ConfigService);
  const appVersion = configService.get('APP_VERSION');

  // TODO: Re-enable auth guard when Prisma/Auth modules are restored
  // const accessTokenGuard = app.get(AccessTokenGuard);
  // app.useGlobalGuards(accessTokenGuard);

  const config = new DocumentBuilder()
    .setTitle('Neverflat API')
    .setVersion(appVersion || '1.0.0')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document);

  // Remove cors when going live
  app.enableCors();

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
    })
  );

  await app.listen(3003);
}
bootstrap();
