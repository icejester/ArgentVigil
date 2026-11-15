// Mechanism cards (mobile-spec.md Story M6, Appendix A). Static, descriptive
// explainers per the AV Voice Rules. `inAv` names where the effect shows up.
export const MECHANISM_CARDS = [
  {
    id: 1,
    title: "The Fed creates money",
    body: [
      "The Fed buys a Treasury or mortgage bond for its portfolio (SOMA). It pays by adding to the reserve account of the seller's bank. Those reserves did not exist a moment earlier; nothing was moved from anywhere else.",
      "What happens next depends on who sold the bond. If the seller was a bank, only reserves rise. If the seller was a fund or other non-bank, its bank also credits its deposit account, so broad money (M2) rises too.",
    ],
    inAv: "The Fed balance sheet and SOMA holdings go up; the QE / QT bars are positive.",
  },
  {
    id: 2,
    title: "The Fed destroys money",
    body: [
      "The Fed rarely sells. Instead, a bond it holds matures and it does not buy a replacement. The Treasury repays the Fed out of its own account at the Fed, and both the bond and that money cease to exist. The Treasury then refills its account by selling new debt to the public, and the buyers' payments drain deposits and reserves out of the banking system.",
      "Because nothing is sold, this never appears as a sale in the transaction record. That is why AV's cumulative net of SOMA transactions runs well above the published SOMA total: the purchases are all there, the maturities are not.",
    ],
    inAv: "The Fed balance sheet and SOMA holdings go down; the QE / QT bars are negative; the gap between the two SOMA lines widens.",
  },
  {
    id: 3,
    title: "Banks create money",
    body: [
      "When a bank makes a loan, it records the loan as an asset and credits the borrower's account with a new deposit. It does not hand over another customer's savings. The deposit is new money, and it counts in M2.",
      "What limits this is the bank's capital, the supply of creditworthy borrowers, and the interest rate, more than the quantity of reserves.",
    ],
    inAv: "Total bank credit rises, and M2 rises with it.",
  },
  {
    id: 4,
    title: "Banks destroy money",
    body: [
      "When a borrower repays principal, the bank cancels the loan and the deposit used to repay it disappears. It is the reverse of the previous card. If repayments outrun new lending, broad money shrinks even if the Fed does nothing.",
    ],
    inAv: "Total bank credit flattens or falls, and M2 follows.",
  },
  {
    id: 5,
    title: "Why the two layers can diverge",
    body: [
      "Reserves can only be held by institutions with accounts at the Fed. A bank cannot lend its reserves to a household or business; they move between banks, or sit. So the Fed can add a great deal to the first layer without the second layer growing in proportion, and the second layer can grow while the first shrinks.",
      "2008 to 2014: the Fed balance sheet grew several times over through QE. M2 grew far less, because bank lending was weak.",
      "2022 onward: the Fed balance sheet shrank through QT. M2 dipped, then resumed growing while the Fed was still shrinking, because bank credit kept expanding.",
    ],
    inAv: "The shaded bands on the Fed balance sheet against M2 chart.",
  },
];
