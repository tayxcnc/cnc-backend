import type { Response } from 'express';
import { csvCell, csvDocument, sendCsvFile, watDateAndClock } from './csv';

describe('CSV', () => {
  it('quotes a cell with a comma, a quote or a line break, doubling quotes', () => {
    expect(csvCell('CASHIER, WAITER')).toBe('"CASHIER, WAITER"');
    expect(csvCell('Ada "Bee" Obi')).toBe('"Ada ""Bee"" Obi"');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell('plain')).toBe('plain');
  });

  it('neutralises a cell a spreadsheet would run as a formula', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+234')).toBe("'+234");
    expect(csvCell('@me')).toBe("'@me");
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('-cmd')).toBe("'-cmd");
    expect(csvCell('+2348012345678')).toBe("'+2348012345678");
  });

  /**
   * A gap is a signed number, and a guarded one opens as text: a column of
   * `'-2` cannot be summed.
   */
  it('leaves a plain number alone, a negative one included', () => {
    expect(csvCell('-2')).toBe('-2');
    expect(csvCell('-4000.00')).toBe('-4000.00');
    expect(csvCell('0')).toBe('0');
    expect(csvCell('4000.00')).toBe('4000.00');
  });

  it('still guards what only starts like a negative number', () => {
    expect(csvCell('-2+3')).toBe("'-2+3");
    expect(csvCell('--2')).toBe("'--2");
    expect(csvCell('-2.')).toBe("'-2.");
    expect(csvCell('-')).toBe("'-");
    expect(csvCell('-1,5')).toBe(`"'-1,5"`);
  });

  it('always has its header, CRLF line ends, and a final line end', () => {
    expect(csvDocument(['A', 'B'], [])).toBe('A,B\r\n');
    expect(csvDocument(['A', 'B'], [['1', '2']])).toBe('A,B\r\n1,2\r\n');
  });

  it('sends a file as a CSV attachment under its name, and answers its body', () => {
    const headers: Record<string, string> = {};
    const response = {
      setHeader: (name: string, value: string) => {
        headers[name] = value;
      },
    } as unknown as Response;

    expect(
      sendCsvFile(response, { filename: 'a-to-b.csv', body: 'A\r\n' }),
    ).toBe('A\r\n');
    expect(headers).toEqual({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="a-to-b.csv"',
    });
  });

  it('writes an instant as its WAT date and clock, and nothing as an empty cell', () => {
    // 23:30 UTC is 00:30 the next day in Nigeria: the date is Nigeria's too.
    expect(watDateAndClock(new Date('2026-10-13T23:30:00.000Z'))).toBe(
      '2026-10-14 00:30',
    );
    expect(watDateAndClock(null)).toBe('');
  });
});
