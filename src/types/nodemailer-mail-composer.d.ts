declare module "nodemailer/lib/mail-composer/index.js" {
  export default class MailComposer {
    constructor(options: Record<string, unknown>);
    compile(): {
      build(callback: (error: Error | null, message: Buffer) => void): void;
    };
  }
}
