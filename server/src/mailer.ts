// Sends the server's emails. Only password reset codes for now.
export type Mailer = {
  sendPasswordResetCode(to: string, code: string): Promise<void>;
};

// Resend (resend.com). The `from` address's domain must be verified in Resend.
export const createResendMailer = (apiKey: string, from: string, fetchImpl: typeof fetch = fetch): Mailer => ({
  async sendPasswordResetCode(to, code) {
    const response = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to,
        subject: `${code} is your Glide Path reset code`,
        text: `Your Glide Path password reset code is ${code}.\n\nEnter it in the app or on the website to choose a new password. It expires in 15 minutes.\n\nIf you didn't ask to reset your password, you can ignore this email.`,
        html: `<p>Your Glide Path password reset code is</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p><p>Enter it in the app or on the website to choose a new password. It expires in 15 minutes.</p><p style="color:#6b7468">If you didn't ask to reset your password, you can ignore this email.</p>`,
      }),
    });
    if (!response.ok) throw new Error(`Resend returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
  },
});

// For local development: prints the code instead of emailing it.
export const consoleMailer: Mailer = {
  async sendPasswordResetCode(to, code) {
    console.log(`Password reset code for ${to}: ${code}`);
  },
};
