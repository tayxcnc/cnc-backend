import { ApiProperty } from '@nestjs/swagger';

/**
 * What Paystack gets back from a signed delivery (TAY's
 * `WebhookAckResponse`): nothing about what happened. Paystack decides
 * whether to retry from the status alone, and a body describing the
 * outcome would tell whoever holds the key whether a reference exists.
 */
export class WebhookAckResponse {
  @ApiProperty({
    description:
      'Always true: the signature verified and the delivery was recorded. ' +
      'It says nothing about whether the work it triggers has finished.',
    example: true,
  })
  received!: boolean;
}
