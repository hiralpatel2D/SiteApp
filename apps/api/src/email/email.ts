/** Outbound email. A real provider replaces `consoleEmailSender` later. */
export interface EmailSender {
  sendInvitation(
    to: string,
    data: { companyName: string; roleName: string; inviteUrl: string; expiresAt: Date },
  ): Promise<void>;
  sendPasswordReset(to: string, data: { resetUrl: string }): Promise<void>;
}

/** Logs links to stdout instead of sending mail (development and early deploys). */
export const consoleEmailSender: EmailSender = {
  async sendInvitation(to, data) {
    console.log(`Invitation for ${to}: ${data.inviteUrl}`);
  },
  async sendPasswordReset(to, data) {
    console.log(`Password reset for ${to}: ${data.resetUrl}`);
  },
};
