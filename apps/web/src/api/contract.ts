/**
 * The API contract between the web app and the server.
 *
 * The types live in the @pump/contract package, which the server imports
 * too, so the two sides can never drift apart. This file only passes them
 * on, so the rest of the app keeps importing from './api/contract'.
 */
export * from '@pump/contract';
