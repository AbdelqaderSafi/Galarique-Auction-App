import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('Galareque Auction API')
    .setDescription(
      'REST API for the Galareque online auction platform.\n\n' +
        '**Authentication:**\n' +
        'Most endpoints require a Bearer JWT token.\n' +
        'Obtain a token via `POST /auth/register`, `POST /auth/login`, `POST /auth/google`, or `POST /auth/apple`.',
    )
    .setVersion('1.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      'access-token',
    )
    .addTag('Auth', 'Registration, login, and social OAuth')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
    },
  });
}
