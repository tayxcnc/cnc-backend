import { ContactChannel } from '../../generated/cnc-client';
import {
  ADDRESS_LINE_TOO_LONG_MESSAGE,
  DELIVERY_LANDMARK_MESSAGE,
  DELIVERY_ZONE_MESSAGE,
  deliveryAddressProblem,
  toDeliveryAddress,
} from '../common/delivery-address';
import {
  CHANNEL_MESSAGE,
  EMAIL_CHANNEL_NEEDS_EMAIL_MESSAGE,
  OFFERS_UNAVAILABLE_MESSAGE,
  PHONE_MESSAGE,
  PREFERENCE_MESSAGE,
  PROFILE_ADDRESS_LINES_MESSAGE,
  SMS_UNAVAILABLE_MESSAGE,
  customerPhone,
  phoneProblem,
  prefsProblem,
  prefsRuleBroken,
  toPrefsChange,
} from './profile-rules';

const ADDRESS = {
  zone: 'JOS',
  street: ' 12 Rayfield Road ',
  area: 'Rayfield',
  town: 'Jos',
  landmark: 'Opposite the filling station',
};

describe('customerPhone and phoneProblem', () => {
  it('stores 0 plus ten digits however the number was typed', () => {
    expect(customerPhone('0803 123 4567')).toBe('08031234567');
    expect(customerPhone('+234-803-123-4567')).toBe('08031234567');
    expect(customerPhone('2348031234567')).toBe('08031234567');
  });

  it('reads null and blank as removing the phone', () => {
    expect(customerPhone(null)).toBeNull();
    expect(customerPhone('   ')).toBeNull();
    expect(phoneProblem(null)).toBeNull();
  });

  it('refuses anything that is not a Nigerian number', () => {
    for (const value of ['12345', '+447700900123', '06031234567', 42]) {
      expect(customerPhone(value)).toBeUndefined();
      expect(phoneProblem(value)).toBe(PHONE_MESSAGE);
    }
  });
});

describe('deliveryAddressProblem (D53)', () => {
  const check = (value: unknown) =>
    deliveryAddressProblem(value, PROFILE_ADDRESS_LINES_MESSAGE);

  it('passes a whole address', () => {
    expect(check(ADDRESS)).toBeNull();
  });

  it('answers in the screens’ order: zone, lines, landmark, length', () => {
    expect(check({ ...ADDRESS, zone: 'LAGOS' })).toBe(DELIVERY_ZONE_MESSAGE);
    expect(check('Jos')).toBe(DELIVERY_ZONE_MESSAGE);
    expect(check({ ...ADDRESS, area: '  ' })).toBe(
      PROFILE_ADDRESS_LINES_MESSAGE,
    );
    expect(check({ ...ADDRESS, landmark: '' })).toBe(DELIVERY_LANDMARK_MESSAGE);
    expect(check({ ...ADDRESS, town: 'x'.repeat(121) })).toBe(
      ADDRESS_LINE_TOO_LONG_MESSAGE,
    );
  });

  it('stores the lines trimmed and nothing else', () => {
    expect(toDeliveryAddress({ ...ADDRESS, extra: 'ignored' })).toEqual({
      zone: 'JOS',
      street: '12 Rayfield Road',
      area: 'Rayfield',
      town: 'Jos',
      landmark: 'Opposite the filling station',
    });
  });
});

describe('the preferences', () => {
  it('checks the shape: switches true or false, a known channel', () => {
    expect(prefsProblem({ orderUpdates: true })).toBeNull();
    expect(prefsProblem({ orderUpdates: 'yes' })).toBe(PREFERENCE_MESSAGE);
    expect(prefsProblem([])).toBe(PREFERENCE_MESSAGE);
    expect(prefsProblem({ channel: 'PIGEON' })).toBe(CHANNEL_MESSAGE);
  });

  it('keeps only the keys sent', () => {
    expect(toPrefsChange({ bookingReminders: false, other: 1 })).toEqual({
      bookingReminders: false,
    });
  });

  it('refuses offers on, SMS, and email without an email', () => {
    expect(prefsRuleBroken({ offers: true }, 'a@b.test')).toBe(
      OFFERS_UNAVAILABLE_MESSAGE,
    );
    expect(prefsRuleBroken({ offers: false }, 'a@b.test')).toBeNull();
    expect(prefsRuleBroken({ channel: ContactChannel.SMS }, 'a@b.test')).toBe(
      SMS_UNAVAILABLE_MESSAGE,
    );
    expect(prefsRuleBroken({ channel: ContactChannel.EMAIL }, null)).toBe(
      EMAIL_CHANNEL_NEEDS_EMAIL_MESSAGE,
    );
    expect(
      prefsRuleBroken({ channel: ContactChannel.EMAIL }, 'a@b.test'),
    ).toBeNull();
  });
});
