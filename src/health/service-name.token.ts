/**
 * Injection token carrying the name of the service this process is.
 *
 * The root module registers it with the literal `'cnc'`. The health
 * controller reads it through DI so it never has to read an environment
 * variable to work out which service it belongs to.
 */
export const SERVICE_NAME = Symbol('SERVICE_NAME');
