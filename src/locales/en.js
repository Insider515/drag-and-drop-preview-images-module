/**
 * English — the base language.
 *
 * Every other dictionary is checked against this one: a key here that is
 * missing there falls back to the English text, so a partial translation
 * degrades into mixed language rather than into blanks or raw key names.
 *
 * A value that is an object is a plural set. English needs `one` and `other`;
 * the count arrives as `{n}`.
 */
import { PLURAL_RULES } from '../core/i18n.js';

export default {
  id: 'en',
  name: 'English',
  tag: 'en',
  plural: PLURAL_RULES.default,
  strings: {
    // ------------------------------------------------------------ shared
    'common.cancel': 'Cancel',
    'common.retry': 'Retry',
    'common.remove': 'Remove',
    'common.removeAll': 'Remove all',
    'common.upload': 'Upload',
    'common.takePhoto': 'Take a photo',
    'common.done': 'Done',

    // --------------------------------------------------------- file size
    'unit.b': 'B',
    'unit.kb': 'KB',
    'unit.mb': 'MB',
    'unit.gb': 'GB',

    // ------------------------------------------------------------ counts
    'count.files': { one: '{n} file', other: '{n} files' },
    'count.selected': { one: '{n} file selected', other: '{n} files selected' },

    // -------------------------------------------------------- drop zone
    'drop.button': 'Choose files',
    'drop.hint': 'or drag them into this area',
    'drop.active': 'Drop the files here',
    'drop.inputLabel': 'Choose images to upload',
    'drop.listLabel': 'Selected images',
    'drop.removeOne': 'Remove {name}',

    // ----------------------------------------------------------- status
    'status.queue': '{files} · {size}',
    'status.uploading': 'Uploading {done} of {total}',
    'status.uploaded': 'Uploaded',
    'status.failed': 'Failed',
    'status.cancelled': 'Upload cancelled',
    'status.retrying': 'Upload failed — trying again ({attempt} of {total})',
    'status.someFailed': 'Uploaded {done}, failed {failed}',

    // ------------------------------------ why a file was not accepted
    'error.EMPTY': 'The file is empty',
    'error.TOO_LARGE': 'Larger than {limit}',
    'error.TOO_MANY': 'At most {limit} files',
    'error.TOTAL_TOO_LARGE': 'Over the total limit of {limit}',
    'error.NOT_AN_IMAGE': 'This is not an image',
    'error.TYPE_NOT_ALLOWED': '{type} is not accepted here',
    'error.SVG_REFUSED': 'SVG is not accepted here',
    'error.DUPLICATE': 'Already chosen',
    'error.TOO_MANY_PIXELS': 'The image has too many pixels',
    'error.DECODE_FAILED': 'The image could not be read',
    'error.NOTHING_TO_UPLOAD': 'Nothing left to upload — every file was refused',

    // ------------------------------- what the server reported, by code
    'srv.NETWORK': 'Could not reach the server',
    'srv.HTTP_ERROR': 'Error {status}',
    'srv.ABORTED': 'Upload cancelled',
    'srv.NO_FILES': 'No files were sent',
    'srv.NOT_MULTIPART': 'multipart/form-data was expected',
    'srv.CROSS_ORIGIN': 'Cross-origin request rejected',
    'srv.TOO_LARGE': 'Larger than the server allows',
    'srv.TOO_MANY': 'More files than the server accepts at once',
    'srv.TOTAL_TOO_LARGE': 'The request is over the size limit',
    'srv.NOT_AN_IMAGE': 'The server did not recognise this as an image',
    'srv.TYPE_NOT_ALLOWED': 'The server does not accept this type',
    'srv.NO_SPACE': 'No space left on the server',
    'srv.DENIED': 'Uploading is not allowed',
    'srv.INTERNAL': 'Internal server error',
    'srv.INFECTED': 'The file was reported as malware',
    'srv.NOT_SCREENED': 'The file could not be checked for malware',
    'srv.SCAN_FAILED': 'The malware check is unavailable, try again',
  },
};
