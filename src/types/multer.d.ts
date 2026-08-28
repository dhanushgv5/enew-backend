// The `multer` package ships without bundled TypeScript types and
// `@types/multer` isn't installed. `@nestjs/platform-express` only types its
// own interceptors/decorators, not multer's storage engines, so declare the
// module loosely here to keep `diskStorage` usable without `any` imports
// elsewhere in the codebase.
declare module 'multer' {
  const diskStorage: (options: {
    destination?: string | ((req: any, file: any, cb: (error: Error | null, destination: string) => void) => void);
    filename?: (req: any, file: any, cb: (error: Error | null, filename: string) => void) => void;
  }) => any;

  const memoryStorage: () => any;

  export { diskStorage, memoryStorage };
}
