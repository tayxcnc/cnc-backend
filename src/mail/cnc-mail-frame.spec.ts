import { frameCncMail } from './cnc-mail-frame';

describe('frameCncMail', () => {
  it('puts the body inside the CNC banner and footer, unescaped', () => {
    const html = frameCncMail({
      html: '<p>Hello &amp; welcome</p>',
      logoUrl: 'https://tayxcnc.com/cnc/icons/icon-192.png',
    });

    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('CHEF NORO CULINARY');
    expect(html).toContain(
      '<div class="cnc-body"><p>Hello &amp; welcome</p></div>',
    );
    expect(html).toContain(
      '<img src="https://tayxcnc.com/cnc/icons/icon-192.png"',
    );
    expect(html).toContain('#4d2d18');
    expect(html).not.toContain('TAY');
  });

  it('shows the wordmark alone when there is no logo URL', () => {
    const html = frameCncMail({ html: '<p>Hi</p>', logoUrl: undefined });

    expect(html).not.toContain('<img');
    expect(html).toContain('CHEF NORO CULINARY');
  });

  it('escapes the logo URL it interpolates', () => {
    const html = frameCncMail({
      html: '<p>Hi</p>',
      logoUrl: 'https://x.example/a.png" onerror="alert(1)',
    });

    expect(html).not.toContain('" onerror="');
    expect(html).toContain('&quot; onerror=&quot;');
  });
});
