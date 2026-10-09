import { BadRequestException, type PipeTransform, applyDecorators } from '@nestjs/common';
import { ApiBody, ApiQuery } from '@nestjs/swagger';
import type { ZodTypeAny, z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/** Validates and transforms input with a Zod schema; unknown keys are stripped. */
export class ZodPipe<T extends ZodTypeAny> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}
  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        error: 'validation_failed',
        message: 'Request validation failed',
        issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return result.data;
  }
}

function toOpenApi(schema: ZodTypeAny): Record<string, unknown> {
  const json = zodToJsonSchema(schema, { target: 'openApi3', $refStrategy: 'none' }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

/** Documents a Zod body schema in OpenAPI. */
export function ApiZodBody(schema: ZodTypeAny) {
  return ApiBody({ schema: toOpenApi(schema) as never });
}

/** Documents each property of a Zod object schema as a query parameter. */
export function ApiZodQuery(schema: ZodTypeAny) {
  const json = toOpenApi(schema) as { properties?: Record<string, Record<string, unknown>>; required?: string[] };
  return applyDecorators(
    ...Object.entries(json.properties ?? {}).map(([name, prop]) =>
      ApiQuery({ name, required: json.required?.includes(name) ?? false, schema: prop as never }),
    ),
  );
}
