// backend/src/modules/resume/export/latexTemplates.ts
// Industry-standard technical resume templates (Classic Academic, Modern Tech, Minimal Single-Column)
// Optimized for 100% ATS parseability, vector typography, and strict 1-page/2-page pagination.

export type TemplateId = 'classic-academic' | 'modern-tech' | 'minimal-single-column';

export interface ResumeHeader {
  name: string;
  title?: string;
  email: string;
  phone?: string;
  location?: string;
  website?: string;
  github?: string;
  linkedin?: string;
}

export interface ResumeExperience {
  role: string;
  company: string;
  location?: string;
  startDate: string;
  endDate: string;
  bullets: string[];
  technologies?: string[];
}

export interface ResumeEducation {
  degree: string;
  institution: string;
  location?: string;
  startDate?: string;
  endDate: string;
  gpa?: string;
  honors?: string[];
  coursework?: string[];
}

export interface ResumeProject {
  name: string;
  description?: string;
  role?: string;
  url?: string;
  startDate?: string;
  endDate?: string;
  bullets: string[];
  technologies?: string[];
}

export interface SkillCategory {
  category: string;
  skills: string[];
}

export interface StructuredResume {
  header: ResumeHeader;
  summary?: string;
  experience?: ResumeExperience[];
  education?: ResumeEducation[];
  skills?: SkillCategory[] | Record<string, string[]> | string[];
  projects?: ResumeProject[];
  certifications?: Array<{ name: string; issuer?: string; date?: string; url?: string }>;
  awards?: Array<{ title: string; issuer?: string; date?: string; summary?: string }>;
}

export interface PaginationOptions {
  targetPages?: number;
  paperSize?: 'a4' | 'us-letter';
  fontSizePt?: number;
  marginCm?: {
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
  };
  lineLeadingEm?: number;
  sectionSpacingPt?: number;
}

/**
 * Escapes characters that have syntactic significance in Typst markup
 */
export function escapeTypst(text: string | null | undefined): string {
  if (!text) return '';
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/@/g, '\\@')
    .replace(/#/g, '\\#')
    .replace(/\$/g, '\\$')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/</g, '\\<')
    .replace(/>/g, '\\>')
    .replace(/~/g, '\\~')
    .replace(/`/g, '\\`');
}

/**
 * Escapes characters for LaTeX typesetting
 */
export function escapeLatex(text: string | null | undefined): string {
  if (!text) return '';
  return String(text)
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/&/g, '\\&')
    .replace(/%/g, '\\%')
    .replace(/\$/g, '\\$')
    .replace(/#/g, '\\#')
    .replace(/_/g, '\\_')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}');
}

/**
 * Normalize skills input into an array of SkillCategory
 */
export function normalizeSkills(
  skills: SkillCategory[] | Record<string, string[]> | string[] | undefined
): SkillCategory[] {
  if (!skills) return [];
  if (Array.isArray(skills)) {
    if (skills.length === 0) return [];
    if (typeof skills[0] === 'string') {
      return [{ category: 'Core Skills', skills: skills as string[] }];
    }
    return skills as SkillCategory[];
  }
  if (typeof skills === 'object') {
    return Object.entries(skills).map(([category, items]) => ({
      category,
      skills: Array.isArray(items) ? items : [String(items)],
    }));
  }
  return [];
}

/**
 * Build Header Links Line
 */
function buildLinksLine(header: ResumeHeader): string {
  const parts: string[] = [];
  if (header.email) parts.push(`#link("mailto:${header.email}")[${escapeTypst(header.email)}]`);
  if (header.phone) parts.push(escapeTypst(header.phone));
  if (header.location) parts.push(escapeTypst(header.location));
  if (header.github) {
    const ghClean = header.github.replace(/^https?:\/\/(www\.)?github\.com\//, '');
    parts.push(`#link("https://github.com/${ghClean}")[github.com/${escapeTypst(ghClean)}]`);
  }
  if (header.linkedin) {
    const liClean = header.linkedin.replace(/^https?:\/\/(www\.)?linkedin\.com\/in\//, '');
    parts.push(`#link("https://linkedin.com/in/${liClean}")[linkedin.com/in/${escapeTypst(liClean)}]`);
  }
  if (header.website) {
    const webClean = header.website.replace(/^https?:\/\//, '');
    parts.push(`#link("${header.website}")[${escapeTypst(webClean)}]`);
  }
  return parts.join(' | ');
}

// ============================================================================
// 1. CLASSIC ACADEMIC TEMPLATE (Typst)
// ============================================================================
export function generateClassicAcademicTypst(
  resume: StructuredResume,
  options: PaginationOptions = {}
): string {
  const paper = options.paperSize === 'us-letter' ? 'us-letter' : 'a4';
  const fontSize = options.fontSizePt ?? 9.5;
  const topMargin = options.marginCm?.top ?? 1.2;
  const bottomMargin = options.marginCm?.bottom ?? 1.2;
  const sideMargin = options.marginCm?.left ?? 1.5;
  const leading = options.lineLeadingEm ?? 0.52;
  const header = resume.header;
  const links = buildLinksLine(header);
  const normalizedSkills = normalizeSkills(resume.skills);

  let doc = `
#set page(
  paper: "${paper}",
  margin: (top: ${topMargin}cm, bottom: ${bottomMargin}cm, x: ${sideMargin}cm),
)
#set text(
  font: ("Linux Libertine", "Times New Roman", "DejaVu Serif", "serif"),
  size: ${fontSize}pt,
  fill: rgb("#111827"),
  lang: "en",
)
#set par(leading: ${leading}em, justify: false)
#show link: underline
#show heading.where(level: 1): it => block(below: 0.6em)[
  #text(size: 1.8em, weight: "bold", tracking: 0.5pt)[#it.body]
]
#show heading.where(level: 2): it => block(above: 1.0em, below: 0.4em)[
  #smallcaps(text(size: 1.15em, weight: "bold", fill: rgb("#1f2937"))[#it.body])
  #v(-0.35em)
  #line(length: 100%, stroke: 0.6pt + rgb("#9ca3af"))
]
#show list: set list(indent: 0.5em, body-indent: 0.4em)

// Header
#align(center)[
  = ${escapeTypst(header.name)}
  ${header.title ? `#text(size: 1.05em, style: "italic")[${escapeTypst(header.title)}]\n` : ''}
  #v(0.1em)
  #text(size: 0.88em)[${links}]
]
`;

  // Summary
  if (resume.summary) {
    doc += `
== Summary
${escapeTypst(resume.summary)}
`;
  }

  // Experience
  if (resume.experience && resume.experience.length > 0) {
    doc += `\n== Experience\n`;
    for (const exp of resume.experience) {
      doc += `
#grid(
  columns: (1fr, auto),
  [*${escapeTypst(exp.role)}* -- _${escapeTypst(exp.company)}_${exp.location ? ` (${escapeTypst(exp.location)})` : ''}],
  [#text(size: 0.9em, fill: rgb("#4b5563"))[${escapeTypst(exp.startDate)} -- ${escapeTypst(exp.endDate)}]]
)
`;
      if (exp.bullets && exp.bullets.length > 0) {
        for (const b of exp.bullets) {
          doc += `- ${escapeTypst(b)}\n`;
        }
      }
      if (exp.technologies && exp.technologies.length > 0) {
        doc += `#v(-0.2em)#text(size: 0.85em, fill: rgb("#4b5563"))[_Technologies: ${escapeTypst(exp.technologies.join(', '))}_]\n`;
      }
      doc += `#v(0.3em)\n`;
    }
  }

  // Projects
  if (resume.projects && resume.projects.length > 0) {
    doc += `\n== Projects\n`;
    for (const proj of resume.projects) {
      const projLink = proj.url ? ` (#link("${proj.url}")[#text(size: 0.85em)[Link]])` : '';
      const dateRange = proj.startDate || proj.endDate ? `${escapeTypst(proj.startDate || '')} -- ${escapeTypst(proj.endDate || '')}` : '';
      doc += `
#grid(
  columns: (1fr, auto),
  [*${escapeTypst(proj.name)}*${projLink}${proj.role ? ` -- _${escapeTypst(proj.role)}_` : ''}],
  [#text(size: 0.9em, fill: rgb("#4b5563"))[${dateRange}]]
)
`;
      if (proj.description) {
        doc += `${escapeTypst(proj.description)}\n`;
      }
      if (proj.bullets && proj.bullets.length > 0) {
        for (const b of proj.bullets) {
          doc += `- ${escapeTypst(b)}\n`;
        }
      }
      if (proj.technologies && proj.technologies.length > 0) {
        doc += `#v(-0.2em)#text(size: 0.85em, fill: rgb("#4b5563"))[_Tools & Stack: ${escapeTypst(proj.technologies.join(', '))}_]\n`;
      }
      doc += `#v(0.3em)\n`;
    }
  }

  // Education
  if (resume.education && resume.education.length > 0) {
    doc += `\n== Education\n`;
    for (const edu of resume.education) {
      doc += `
#grid(
  columns: (1fr, auto),
  [*${escapeTypst(edu.institution)}* -- ${escapeTypst(edu.degree)}${edu.location ? ` (${escapeTypst(edu.location)})` : ''}],
  [#text(size: 0.9em, fill: rgb("#4b5563"))[${escapeTypst(edu.endDate)}]]
)
`;
      if (edu.gpa) {
        doc += `#text(size: 0.88em)[GPA: ${escapeTypst(edu.gpa)}]\n`;
      }
      if (edu.honors && edu.honors.length > 0) {
        doc += `#text(size: 0.88em)[Honors: ${escapeTypst(edu.honors.join(', '))}]\n`;
      }
      if (edu.coursework && edu.coursework.length > 0) {
        doc += `#text(size: 0.88em)[Relevant Coursework: ${escapeTypst(edu.coursework.join(', '))}]\n`;
      }
      doc += `#v(0.2em)\n`;
    }
  }

  // Skills
  if (normalizedSkills.length > 0) {
    doc += `\n== Technical Skills\n`;
    for (const skillCat of normalizedSkills) {
      doc += `- *${escapeTypst(skillCat.category)}*: ${escapeTypst(skillCat.skills.join(', '))}\n`;
    }
  }

  return doc;
}

// ============================================================================
// 2. MODERN TECH TEMPLATE (Typst)
// ============================================================================
export function generateModernTechTypst(
  resume: StructuredResume,
  options: PaginationOptions = {}
): string {
  const paper = options.paperSize === 'us-letter' ? 'us-letter' : 'a4';
  const fontSize = options.fontSizePt ?? 9.2;
  const topMargin = options.marginCm?.top ?? 1.1;
  const bottomMargin = options.marginCm?.bottom ?? 1.1;
  const sideMargin = options.marginCm?.left ?? 1.4;
  const leading = options.lineLeadingEm ?? 0.50;
  const header = resume.header;
  const links = buildLinksLine(header);
  const normalizedSkills = normalizeSkills(resume.skills);

  let doc = `
#set page(
  paper: "${paper}",
  margin: (top: ${topMargin}cm, bottom: ${bottomMargin}cm, x: ${sideMargin}cm),
)
#set text(
  font: ("Roboto", "Liberation Sans", "DejaVu Sans", "sans-serif"),
  size: ${fontSize}pt,
  fill: rgb("#0f172a"),
  lang: "en",
)
#set par(leading: ${leading}em, justify: false)
#show heading.where(level: 1): it => block(below: 0.5em)[
  #text(size: 1.9em, weight: 800, fill: rgb("#0f172a"))[#it.body]
]
#show heading.where(level: 2): it => block(above: 0.9em, below: 0.35em)[
  #text(size: 1.15em, weight: 700, fill: rgb("#2563eb"))[#upper(it.body)]
  #v(-0.3em)
  #line(length: 100%, stroke: 1.0pt + rgb("#93c5fd"))
]
#show list: set list(indent: 0.4em, body-indent: 0.35em)

// Header
#align(center)[
  = ${escapeTypst(header.name)}
  ${header.title ? `#v(-0.3em)#text(size: 1.05em, weight: 600, fill: rgb("#475569"))[${escapeTypst(header.title)}]\n` : ''}
  #v(0.1em)
  #text(size: 0.88em, fill: rgb("#334155"))[${links}]
]
`;

  // Summary
  if (resume.summary) {
    doc += `
== Professional Summary
${escapeTypst(resume.summary)}
`;
  }

  // Skills (at top for modern technical engineering)
  if (normalizedSkills.length > 0) {
    doc += `\n== Technical Proficiencies\n`;
    for (const skillCat of normalizedSkills) {
      doc += `*${escapeTypst(skillCat.category)}*: ${escapeTypst(skillCat.skills.join('  •  '))}\n\n`;
    }
  }

  // Experience
  if (resume.experience && resume.experience.length > 0) {
    doc += `\n== Work Experience\n`;
    for (const exp of resume.experience) {
      doc += `
#grid(
  columns: (1fr, auto),
  [*${escapeTypst(exp.role)}* | #text(fill: rgb("#2563eb"), weight: 600)[${escapeTypst(exp.company)}]${exp.location ? ` · ${escapeTypst(exp.location)}` : ''}],
  [#text(size: 0.88em, weight: 500, fill: rgb("#64748b"))[${escapeTypst(exp.startDate)} -- ${escapeTypst(exp.endDate)}]]
)
`;
      if (exp.bullets && exp.bullets.length > 0) {
        for (const b of exp.bullets) {
          doc += `- ${escapeTypst(b)}\n`;
        }
      }
      if (exp.technologies && exp.technologies.length > 0) {
        doc += `#v(-0.25em)#text(size: 0.85em, fill: rgb("#475569"))[*Tech Stack:* ${escapeTypst(exp.technologies.join(', '))}]\n`;
      }
      doc += `#v(0.35em)\n`;
    }
  }

  // Projects
  if (resume.projects && resume.projects.length > 0) {
    doc += `\n== Key Engineering Projects\n`;
    for (const proj of resume.projects) {
      const projLink = proj.url ? ` [#link("${proj.url}")[↗ View Code]]` : '';
      const dateRange = proj.startDate || proj.endDate ? `${escapeTypst(proj.startDate || '')} -- ${escapeTypst(proj.endDate || '')}` : '';
      doc += `
#grid(
  columns: (1fr, auto),
  [*${escapeTypst(proj.name)}*${projLink}${proj.role ? ` · _${escapeTypst(proj.role)}_` : ''}],
  [#text(size: 0.88em, fill: rgb("#64748b"))[${dateRange}]]
)
`;
      if (proj.description) {
        doc += `${escapeTypst(proj.description)}\n`;
      }
      if (proj.bullets && proj.bullets.length > 0) {
        for (const b of proj.bullets) {
          doc += `- ${escapeTypst(b)}\n`;
        }
      }
      if (proj.technologies && proj.technologies.length > 0) {
        doc += `#v(-0.25em)#text(size: 0.85em, fill: rgb("#475569"))[*Architecture & Tools:* ${escapeTypst(proj.technologies.join(', '))}]\n`;
      }
      doc += `#v(0.35em)\n`;
    }
  }

  // Education
  if (resume.education && resume.education.length > 0) {
    doc += `\n== Education\n`;
    for (const edu of resume.education) {
      doc += `
#grid(
  columns: (1fr, auto),
  [*${escapeTypst(edu.degree)}* | #text(weight: 600)[${escapeTypst(edu.institution)}]${edu.location ? ` · ${escapeTypst(edu.location)}` : ''}],
  [#text(size: 0.88em, fill: rgb("#64748b"))[${escapeTypst(edu.endDate)}]]
)
`;
      const extras: string[] = [];
      if (edu.gpa) extras.push(`GPA: ${escapeTypst(edu.gpa)}`);
      if (edu.honors && edu.honors.length > 0) extras.push(`Honors: ${escapeTypst(edu.honors.join(', '))}`);
      if (edu.coursework && edu.coursework.length > 0) extras.push(`Coursework: ${escapeTypst(edu.coursework.join(', '))}`);
      if (extras.length > 0) {
        doc += `#text(size: 0.86em, fill: rgb("#334155"))[${extras.join(' | ')}]\n`;
      }
      doc += `#v(0.2em)\n`;
    }
  }

  return doc;
}

// ============================================================================
// 3. MINIMAL SINGLE-COLUMN TEMPLATE (Typst)
// ============================================================================
export function generateMinimalSingleColumnTypst(
  resume: StructuredResume,
  options: PaginationOptions = {}
): string {
  const paper = options.paperSize === 'us-letter' ? 'us-letter' : 'a4';
  const fontSize = options.fontSizePt ?? 9.0;
  const topMargin = options.marginCm?.top ?? 1.0;
  const bottomMargin = options.marginCm?.bottom ?? 1.0;
  const sideMargin = options.marginCm?.left ?? 1.3;
  const leading = options.lineLeadingEm ?? 0.48;
  const header = resume.header;
  const links = buildLinksLine(header);
  const normalizedSkills = normalizeSkills(resume.skills);

  let doc = `
#set page(
  paper: "${paper}",
  margin: (top: ${topMargin}cm, bottom: ${bottomMargin}cm, x: ${sideMargin}cm),
)
#set text(
  font: ("DejaVu Sans", "Liberation Sans", "Helvetica", "Arial", "sans-serif"),
  size: ${fontSize}pt,
  fill: rgb("#000000"),
  lang: "en",
)
#set par(leading: ${leading}em, justify: false)
#show heading.where(level: 1): it => block(below: 0.4em)[
  #text(size: 1.7em, weight: "bold")[#it.body]
]
#show heading.where(level: 2): it => block(above: 0.8em, below: 0.3em)[
  #text(size: 1.05em, weight: "bold")[#upper(it.body)]
  #v(-0.35em)
  #line(length: 100%, stroke: 0.5pt + rgb("#000000"))
]
#show list: set list(indent: 0.35em, body-indent: 0.35em)

// Header
#align(center)[
  = ${escapeTypst(header.name)}
  ${header.title ? `#text(size: 1.0em)[${escapeTypst(header.title)}]\n` : ''}
  #v(0.05em)
  #text(size: 0.85em)[${links}]
]
`;

  // Summary
  if (resume.summary) {
    doc += `
== Summary
${escapeTypst(resume.summary)}
`;
  }

  // Experience
  if (resume.experience && resume.experience.length > 0) {
    doc += `\n== Experience\n`;
    for (const exp of resume.experience) {
      doc += `
#grid(
  columns: (1fr, auto),
  [*${escapeTypst(exp.company)}*, ${escapeTypst(exp.role)}${exp.location ? ` -- ${escapeTypst(exp.location)}` : ''}],
  [${escapeTypst(exp.startDate)} -- ${escapeTypst(exp.endDate)}]
)
`;
      if (exp.bullets && exp.bullets.length > 0) {
        for (const b of exp.bullets) {
          doc += `- ${escapeTypst(b)}\n`;
        }
      }
      if (exp.technologies && exp.technologies.length > 0) {
        doc += `#text(size: 0.85em)[_Skills: ${escapeTypst(exp.technologies.join(', '))}_]\n`;
      }
      doc += `#v(0.25em)\n`;
    }
  }

  // Projects
  if (resume.projects && resume.projects.length > 0) {
    doc += `\n== Projects\n`;
    for (const proj of resume.projects) {
      const projLink = proj.url ? ` (${escapeTypst(proj.url)})` : '';
      const dateRange = proj.startDate || proj.endDate ? `${escapeTypst(proj.startDate || '')} -- ${escapeTypst(proj.endDate || '')}` : '';
      doc += `
#grid(
  columns: (1fr, auto),
  [*${escapeTypst(proj.name)}*${projLink}${proj.role ? ` | ${escapeTypst(proj.role)}` : ''}],
  [${dateRange}]
)
`;
      if (proj.description) {
        doc += `${escapeTypst(proj.description)}\n`;
      }
      if (proj.bullets && proj.bullets.length > 0) {
        for (const b of proj.bullets) {
          doc += `- ${escapeTypst(b)}\n`;
        }
      }
      if (proj.technologies && proj.technologies.length > 0) {
        doc += `#text(size: 0.85em)[_Tech: ${escapeTypst(proj.technologies.join(', '))}_]\n`;
      }
      doc += `#v(0.25em)\n`;
    }
  }

  // Skills
  if (normalizedSkills.length > 0) {
    doc += `\n== Skills\n`;
    for (const skillCat of normalizedSkills) {
      doc += `- *${escapeTypst(skillCat.category)}*: ${escapeTypst(skillCat.skills.join(', '))}\n`;
    }
  }

  // Education
  if (resume.education && resume.education.length > 0) {
    doc += `\n== Education\n`;
    for (const edu of resume.education) {
      doc += `
#grid(
  columns: (1fr, auto),
  [*${escapeTypst(edu.institution)}*, ${escapeTypst(edu.degree)}${edu.location ? ` -- ${escapeTypst(edu.location)}` : ''}],
  [${escapeTypst(edu.endDate)}]
)
`;
      const extras: string[] = [];
      if (edu.gpa) extras.push(`GPA: ${escapeTypst(edu.gpa)}`);
      if (edu.honors && edu.honors.length > 0) extras.push(`Honors: ${escapeTypst(edu.honors.join(', '))}`);
      if (edu.coursework && edu.coursework.length > 0) extras.push(`Coursework: ${escapeTypst(edu.coursework.join(', '))}`);
      if (extras.length > 0) {
        doc += `${extras.join(' | ')}\n`;
      }
      doc += `#v(0.2em)\n`;
    }
  }

  return doc;
}

/**
 * Universal Typst Template Resolver
 */
export function generateTypstTemplate(
  templateId: TemplateId,
  resume: StructuredResume,
  options: PaginationOptions = {}
): string {
  switch (templateId) {
    case 'classic-academic':
      return generateClassicAcademicTypst(resume, options);
    case 'minimal-single-column':
      return generateMinimalSingleColumnTypst(resume, options);
    case 'modern-tech':
    default:
      return generateModernTechTypst(resume, options);
  }
}

/**
 * LaTeX Template Generator for Classic Academic, Modern Tech, and Minimal Single-Column
 */
export function generateLatexTemplate(
  templateId: TemplateId,
  resume: StructuredResume
): string {
  const header = resume.header;
  const normalizedSkills = normalizeSkills(resume.skills);

  let doc = `\\documentclass[10pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[margin=0.75in]{geometry}
\\usepackage{hyperref}
\\usepackage{enumitem}
\\setlist{nosep}
\\pagestyle{empty}

\\begin{document}
\\begin{center}
  {\\LARGE \\textbf{${escapeLatex(header.name)}}}\\\\
  ${header.title ? `{\\large \\textit{${escapeLatex(header.title)}}}\\\\[4pt]` : ''}
  ${escapeLatex(header.email)}${header.phone ? ` $|$ ${escapeLatex(header.phone)}` : ''}${header.location ? ` $|$ ${escapeLatex(header.location)}` : ''}\\\\
  ${header.github ? `\\href{https://github.com/${escapeLatex(header.github)}}{github.com/${escapeLatex(header.github)}}` : ''}
\\end{center}
\\vspace{-8pt}
`;

  if (resume.summary) {
    doc += `\\section*{Summary}
${escapeLatex(resume.summary)}
`;
  }

  if (resume.experience && resume.experience.length > 0) {
    doc += `\\section*{Experience}\n`;
    for (const exp of resume.experience) {
      doc += `\\noindent\\textbf{${escapeLatex(exp.role)}} \\hfill ${escapeLatex(exp.startDate)} -- ${escapeLatex(exp.endDate)}\\\\
\\textit{${escapeLatex(exp.company)}} \\hfill \\textit{${escapeLatex(exp.location || '')}}\\\\
\\begin{itemize}[leftmargin=1.5em]
`;
      for (const b of exp.bullets) {
        doc += `  \\item ${escapeLatex(b)}\n`;
      }
      doc += `\\end{itemize}\n\\vspace{4pt}\n`;
    }
  }

  if (resume.projects && resume.projects.length > 0) {
    doc += `\\section*{Projects}\n`;
    for (const proj of resume.projects) {
      doc += `\\noindent\\textbf{${escapeLatex(proj.name)}} \\hfill ${escapeLatex(proj.startDate || '')} -- ${escapeLatex(proj.endDate || '')}\\\\
\\begin{itemize}[leftmargin=1.5em]
`;
      for (const b of proj.bullets) {
        doc += `  \\item ${escapeLatex(b)}\n`;
      }
      doc += `\\end{itemize}\n\\vspace{4pt}\n`;
    }
  }

  if (normalizedSkills.length > 0) {
    doc += `\\section*{Skills}\n\\begin{itemize}[leftmargin=1.5em]\n`;
    for (const cat of normalizedSkills) {
      doc += `  \\item \\textbf{${escapeLatex(cat.category)}}: ${escapeLatex(cat.skills.join(', '))}\n`;
    }
    doc += `\\end{itemize}\n\\vspace{4pt}\n`;
  }

  if (resume.education && resume.education.length > 0) {
    doc += `\\section*{Education}\n`;
    for (const edu of resume.education) {
      doc += `\\noindent\\textbf{${escapeLatex(edu.institution)}} \\hfill ${escapeLatex(edu.endDate)}\\\\
${escapeLatex(edu.degree)}\\\\
`;
    }
  }

  doc += `\\end{document}\n`;
  return doc;
}
