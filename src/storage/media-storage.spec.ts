import { parseGsUri } from './media-storage';

describe('parseGsUri', () => {
  it('splits a stored URI into its bucket and object', () => {
    expect(parseGsUri('gs://cnc-media/staff/abc/photo-1.jpg')).toEqual({
      bucket: 'cnc-media',
      objectName: 'staff/abc/photo-1.jpg',
    });
  });

  it('throws on anything that is not a gs:// URI, rather than guessing a bucket', () => {
    for (const value of [
      'https://storage.googleapis.com/cnc-media/x.jpg',
      'gs://cnc-media',
      'gs:///x.jpg',
      'staff/abc/photo.jpg',
    ]) {
      expect(() => parseGsUri(value)).toThrow('Not a gs:// URI');
    }
  });
});
