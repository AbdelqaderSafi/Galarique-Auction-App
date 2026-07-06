// أرقام فلسطين: رمز الدولة +970 (أو +972)، والجوّال يبدأ بـ 59 (جوّال) أو 56 (Ooredoo/Wataniya).
// الصيغة القياسية (E.164 بدون '+'): 970|972 + 5[69] + 7 أرقام = 12 رقماً.
const PS_MOBILE_RE = /^(970|972)5[69]\d{7}$/;

/**
 * يوحّد رقم فلسطيني لأي صيغة مدخلة (+970..، 00970..، 059..، 59..) إلى صيغة
 * `9705XXXXXXXX` الصالحة لـ WhatsApp JID. يرجّع null إذا كان الرقم غير صالح.
 */
export function normalizePalestinianPhone(input: string): string | null {
  let digits = input.replace(/[^\d+]/g, '');

  if (digits.startsWith('+')) digits = digits.slice(1);
  if (digits.startsWith('00')) digits = digits.slice(2);

  // صيغة محلية 059XXXXXXX → 970..
  if (digits.startsWith('0')) digits = '970' + digits.slice(1);
  // بدون بادئة (59XXXXXXX) → 970..
  if (/^5[69]\d{7}$/.test(digits)) digits = '970' + digits;

  return PS_MOBILE_RE.test(digits) ? digits : null;
}
