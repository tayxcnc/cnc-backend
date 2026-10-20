import { writeFile } from 'node:fs/promises';
import { INestApplication, Logger } from '@nestjs/common';
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
} from '@nestjs/swagger';
import { CncConfigService } from './config/cnc.config';

/**
 * Where the UI is served. Deliberately outside the /api/v1 global prefix: the
 * documentation is not a versioned resource of the API it documents.
 */
const DOCS_PATH = 'api/docs';

/** Written relative to the process working directory, i.e. the repo root. */
const SPEC_FILE = './openapi-cnc.json';

/**
 * The CNC OpenAPI document for an application.
 *
 * Exported so `test/cors.e2e-spec.ts` reads the very document this service
 * publishes when it checks that every route's method is one CORS allows.
 */
export function buildCncDocument(app: INestApplication): OpenAPIObject {
  return SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('CNC API')
      .setDescription(
        'The CNC (Chef Noro Culinary) service. CNC and TAY are ' +
          'separately-owned businesses that share no database, no auth realm ' +
          'and no environment; a token issued by TAY is rejected here, and ' +
          'this document describes CNC only.',
      )
      .setVersion('1.0')
      // Default scheme name, 'bearer', so routes need only a bare
      // @ApiBearerAuth() to become testable from the Authorize button.
      .addBearerAuth({
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'A CNC access token: the `accessToken` from a sign-in or refresh ' +
          'response. Paste the raw token; Swagger adds the "Bearer " prefix.',
      })
      .build(),
  );
}

/**
 * Mounts the Swagger UI and, outside a container, exports the spec.
 *
 * The generated document is the contract: the frontends read endpoint shapes
 * from it and Prism mocks against the exported file (`npm run mock`), so
 * anything not decorated on a controller does not exist as far as the rest of
 * the project is concerned.
 *
 * **Not in production.** A free, indexed, always-current map of every route,
 * staff routes included, offered to anyone who types /api/docs, is what TAY's
 * Phase 4 removed from its production service. Staging keeps it: staging is
 * where the frontends are tested against a real API.
 *
 * **No file write in a container.** NODE_ENV is `production` in every built
 * image, staging included. The filesystem there is ephemeral and not reliably
 * writable, so attempting it would turn a documentation convenience into a
 * boot failure.
 */
export async function setupCncSwagger(app: INestApplication): Promise<void> {
  const config = app.get(CncConfigService);

  // Before the document is even built: generating it walks every controller
  // and every DTO, and there is no reason to pay for one that will not be used.
  if (config.cncEnv === 'production') {
    Logger.log('Swagger UI not mounted: CNC_ENV is production', 'CncSwagger');
    return;
  }

  const document = buildCncDocument(app);

  SwaggerModule.setup(DOCS_PATH, app, document);

  if (config.nodeEnv === 'production') {
    Logger.log(
      `Swagger UI mounted at /${DOCS_PATH}; spec export skipped in a container`,
      'CncSwagger',
    );
    return;
  }

  await writeFile(SPEC_FILE, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

  Logger.log(
    `Swagger UI mounted at /${DOCS_PATH}; spec written to ${SPEC_FILE}`,
    'CncSwagger',
  );
}
