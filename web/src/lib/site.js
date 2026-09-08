/* Site-wide constants that marketing changes more often than engineering does.
   Kept in one file so a copy change is a one-line diff rather than a hunt. */

/* Where every "Book a demo" control points. Today this is the live Enghouse
   Interactive enquiry form, which is the only public route to an account team.
   If a dedicated demo-booking page or a scheduling link ever exists, this is
   the single line to change -- the header button, the closing band and the
   footer all read from here. */
export const DEMO_URL = "https://www.enghouseinteractive.com/about-us/contact-us/";

/* ---------------------------------------------------------------------------
   Naming, settled once so the page cannot drift

   EnghouseAI              the AI portfolio wrapped around the contact centre
                           platforms
     Enghouse Virtual Agent  the product inside it that holds the conversation
     ("EVA")                 and completes the task
       AI agent              one deployed EVA, working a queue alongside human
                             agents and managed the same way

   Rules for copy anywhere on this site:
     - First mention in a section: "EVA, the Enghouse Virtual Agent".
       Thereafter: "EVA".
     - "AI agent" is lower case and means a deployed instance. It is the word
       to use whenever the sentence also mentions human agents.
     - "Virtual Agent" capitalised appears only as part of the product's full
       name. It is never a fourth, separate concept.
     - EVA takes "it", not "she". The measurement and governance sections have
       to read as software an operations manager can hold to a number, and
       server-side personas.py already describes the product as "it".
   --------------------------------------------------------------------------- */
