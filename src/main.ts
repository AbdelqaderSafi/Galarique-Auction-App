import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { setupSwagger } from './swagger/swagger.setup';

async function bootstrap() {
  // rawBody: true يوفّر req.rawBody للـ Stripe webhook مع إبقاء JSON parsing لباقي المسارات
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.enableCors(); // يسمح للفرونت/الموبايل بالوصول
  setupSwagger(app);
  await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
}
bootstrap();
