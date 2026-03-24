import nodemailer, { type SentMessageInfo, type Transporter } from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type { ProtonMailConfig, SendEmailInput } from "../types/index.js";

export class SMTPService {
  private transporter?: Transporter;

  constructor(private readonly config: ProtonMailConfig) {}

  async verifyConnection(): Promise<void> {
    const transporter = this.getTransporter();
    await transporter.verify();
  }

  async sendEmail(input: SendEmailInput): Promise<SentMessageInfo> {
    const transporter = this.getTransporter();
    return transporter.sendMail(this.buildMailOptions(input));
  }

  async buildRawMessage(input: SendEmailInput): Promise<Buffer> {
    const composer = new MailComposer(this.buildMailOptions(input));
    return new Promise<Buffer>((resolve, reject) => {
      composer.compile().build((error, message) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(message);
      });
    });
  }

  async sendTestEmail(to: string, customMessage?: string): Promise<SentMessageInfo> {
    const message =
      customMessage ??
      [
        "This is a ProtonMail MCP connectivity test.",
        "",
        `Sent at ${new Date().toISOString()}.`,
      ].join("\n");

    return this.sendEmail({
      to: [to],
      subject: "ProtonMail MCP test email",
      body: message,
      isHtml: false,
    });
  }

  async close(): Promise<void> {
    if (!this.transporter) {
      return;
    }

    this.transporter.close();
    this.transporter = undefined;
  }

  private getTransporter(): Transporter {
    if (!this.transporter) {
      const host = this.config.smtp.host.trim().toLowerCase();
      const isLocalhost = host === "127.0.0.1" || host === "localhost" || host === "::1";

      this.transporter = nodemailer.createTransport({
        host: this.config.smtp.host,
        port: this.config.smtp.port,
        secure: this.config.smtp.secure,
        auth: {
          user: this.config.smtp.username,
          pass: this.config.smtp.password,
        },
        tls: isLocalhost ? { rejectUnauthorized: false } : undefined,
      });
    }

    return this.transporter;
  }

  private buildMailOptions(input: SendEmailInput): Record<string, unknown> {
    const attachments = (input.attachments ?? []).map((attachment) => {
      const contentDisposition: "attachment" | "inline" | undefined =
        attachment.contentDisposition === "inline"
          ? "inline"
          : attachment.contentDisposition === "attachment"
            ? "attachment"
            : undefined;

      return {
        filename: attachment.filename,
        content: Buffer.from(attachment.content, "base64"),
        contentType: attachment.contentType,
        cid: attachment.cid,
        contentDisposition,
        encoding: "base64",
      };
    });

    return {
      from: this.config.smtp.username,
      to: input.to.join(", "),
      cc: input.cc?.join(", "),
      bcc: input.bcc?.join(", "),
      subject: input.subject,
      text: input.isHtml ? undefined : input.body,
      html: input.isHtml ? input.body : undefined,
      replyTo: input.replyTo,
      inReplyTo: input.inReplyTo,
      references: input.references,
      messageId: input.messageId,
      attachments,
      priority: input.priority ?? "normal",
    };
  }
}
