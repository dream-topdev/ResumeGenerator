require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { OpenAI } = require('openai');
const jwt = require('jsonwebtoken');
const User = require('./models/User');
const auth = require('./middleware/auth');
const sgMail = require('@sendgrid/mail');
const PDFDocument = require('pdfkit');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { promisify } = require('util');
const libreofficeConvert = require('libreoffice-convert');
const convertAsync = promisify(libreofficeConvert.convert);

const app = express();
const port = process.env.PORT || 3030;
const host = process.env.HOST || '0.0.0.0';

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Initialize SendGrid
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));
app.use(helmet());
app.use(morgan('dev'));
app.use(express.json());

// Serve static files from the React build directory
app.use(express.static(path.join(__dirname, '../../frontend/build')));

// Add multer for handling file uploads
const upload = multer({ storage: multer.memoryStorage() });

// Helper function to send password reset email
const sendPasswordResetEmail = async (email, token) => {
  const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${token}`;
  const msg = {
    to: email,
    from: process.env.SENDGRID_EMAIL_FROM,
    subject: 'Reset your password',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h1 style="color: #2D3748; text-align: center;">Password Reset Request</h1>
        <p style="color: #4A5568; font-size: 16px; line-height: 1.5;">
          We received a request to reset your password. Click the button below to create a new password:
        </p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${resetUrl}" 
             style="background-color: #4299E1; color: white; padding: 12px 24px; 
                    text-decoration: none; border-radius: 4px; font-weight: bold;">
            Reset Password
          </a>
        </div>
        <p style="color: #718096; font-size: 14px;">
          This link will expire in 1 hour.
        </p>
        <p style="color: #718096; font-size: 14px;">
          If you did not request a password reset, you can safely ignore this email.
        </p>
        <p style="color: #718096; font-size: 14px;">
          If the button above doesn't work, you can also copy and paste this link into your browser:
          <br/>
          <a href="${resetUrl}" style="color: #4299E1;">${resetUrl}</a>
        </p>
      </div>
    `
  };

  try {
    await sgMail.send(msg);
  } catch (error) {
    console.error('SendGrid error:', error);
    if (error.response) {
      console.error(error.response.body);
    }
    throw new Error('Failed to send password reset email');
  }
};

// Authentication routes
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, full_name, phone, personal_email, linkedin_url, github_url } = req.body;

    // Check if user already exists
    const existingUser = await User.findByEmail(email);
    if (existingUser) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    // Create new user
    const { id: userId } = await User.create({
      email,
      password,
      full_name,
      phone,
      personal_email,
      linkedin_url,
      github_url
    });

    // Generate JWT token
    const token = jwt.sign({ id: userId, email }, process.env.JWT_SECRET, { expiresIn: '7d' });

    res.status(201).json({ token });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Failed to register user' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password, rememberMe } = req.body;

    // Verify credentials
    const isValid = await User.verifyPassword(email, password);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Get user data
    const user = await User.findByEmail(email);

    // Generate JWT token with longer expiration if rememberMe is true
    const token = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: rememberMe ? '30d' : '7d' }
    );

    res.json({ token });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Failed to login' });
  }
});

app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findByEmail(email);

    if (!user) {
      // Don't reveal if email exists or not
      return res.json({ message: 'If your email is registered, you will receive a password reset link' });
    }

    const token = await User.generatePasswordResetToken(email);
    await sendPasswordResetEmail(email, token);

    res.json({ message: 'If your email is registered, you will receive a password reset link' });
  } catch (error) {
    console.error('Password reset request error:', error);
    res.status(500).json({ error: 'Failed to process password reset request' });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    const success = await User.resetPassword(token, newPassword);

    if (success) {
      res.json({ message: 'Password reset successfully' });
    } else {
      res.status(400).json({ error: 'Invalid or expired reset token' });
    }
  } catch (error) {
    console.error('Password reset error:', error);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// User profile routes
app.get('/api/profile', auth, async (req, res) => {
  try {
    const user = await User.findByEmail(req.user.email);
    const employmentHistory = await User.getEmploymentHistory(user.id);
    const education = await User.getEducation(user.id);
    
    // Remove sensitive data
    delete user.password;
    
    res.json({ user, employmentHistory, education });
  } catch (error) {
    console.error('Profile fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

app.put('/api/profile', auth, async (req, res) => {
  try {
    await User.updateProfile(req.user.id, req.body);
    res.json({ message: 'Profile updated successfully' });
  } catch (error) {
    console.error('Profile update error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Employment history routes
app.post('/api/employment', auth, async (req, res) => {
  try {
    const employmentId = await User.addEmploymentHistory(req.user.id, req.body);
    res.status(201).json({ id: employmentId });
  } catch (error) {
    console.error('Employment history add error:', error);
    res.status(500).json({ error: 'Failed to add employment history' });
  }
});

app.put('/api/employment/:id', auth, async (req, res) => {
  try {
    await User.updateEmploymentHistory(req.params.id, req.body);
    res.json({ message: 'Employment history updated successfully' });
  } catch (error) {
    console.error('Employment history update error:', error);
    res.status(500).json({ error: 'Failed to update employment history' });
  }
});

app.delete('/api/employment/:id', auth, async (req, res) => {
  try {
    await User.deleteEmploymentHistory(req.params.id);
    res.json({ message: 'Employment history deleted successfully' });
  } catch (error) {
    console.error('Employment history delete error:', error);
    res.status(500).json({ error: 'Failed to delete employment history' });
  }
});

// Education routes
app.post('/api/education', auth, async (req, res) => {
  try {
    const educationId = await User.addEducation(req.user.id, req.body);
    res.status(201).json({ id: educationId });
  } catch (error) {
    console.error('Education add error:', error);
    res.status(500).json({ error: 'Failed to add education' });
  }
});

app.get('/api/education', auth, async (req, res) => {
  try {
    const education = await User.getEducation(req.user.id);
    res.json(education);
  } catch (error) {
    console.error('Education fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch education' });
  }
});

app.put('/api/education/:id', auth, async (req, res) => {
  try {
    await User.updateEducation(req.params.id, req.body);
    res.json({ message: 'Education updated successfully' });
  } catch (error) {
    console.error('Education update error:', error);
    res.status(500).json({ error: 'Failed to update education' });
  }
});

app.delete('/api/education/:id', auth, async (req, res) => {
  try {
    await User.deleteEducation(req.params.id);
    res.json({ message: 'Education deleted successfully' });
  } catch (error) {
    console.error('Education delete error:', error);
    res.status(500).json({ error: 'Failed to delete education' });
  }
});

// Resume generation endpoint
app.post('/api/generate-resume', auth, async (req, res) => {
  try {
    const { jobDescription } = req.body;

    if (!jobDescription) {
      return res.status(400).json({ error: 'Job description is required' });
    }

    // Get user data, employment history, and education
    const user = await User.findByEmail(req.user.email);
    const employmentHistory = await User.getEmploymentHistory(user.id);
    const education = await User.getEducation(user.id);

    // Format employment history for the prompt
    const formattedHistory = employmentHistory.map(job => `
      o ${job.company_name}, ${job.location}
        - ${job.position} (${job.start_date}–${job.is_current ? 'Present' : job.end_date})
        ${job.description ? `- ${job.description}` : ''}
    `).join('\n');

    // Format education history for the prompt
    const formattedEducation = education.map(edu => `
      o ${edu.school_name}, ${edu.location}
        - ${edu.degree} in ${edu.field_of_study} (${edu.start_date}–${edu.is_current ? 'Present' : edu.end_date})
        ${edu.gpa ? `- GPA: ${edu.gpa}` : ''}
        ${edu.description ? `- ${edu.description}` : ''}
    `).join('\n');

    const prompt = `Generate a resume for ${user.full_name} as a JSON object with the following structure:
{
  "name": "${user.full_name}",
  "contact": {
    "email": "${user.personal_email}",
    "phonenumber": "${user.phone}",
    "linkedinURL": "${user.linkedin_url}",
    "location": "${user.location}",
    "github": "${user.github_url}"
  },
  "summary": "[professional summary]",
  "experience": [
    {
      "company": "[company1]",
      "dates": "[date]",
      "location": "[location]",
      "position": "[Role]",
      "bullets": [
        "[experience sentence]",
        "..."
      ]
    },
    ...
  ],
  "skills": [
    {
      "section": "[section name]",
      "list": ["[skill1]", "[skill2]", "..."]
    },
    ...
  ],
  "education": [
    {
      "school": "[Name of School]",
      "location": "[Location]",
      "dates": "[date]",
      "program": "[Program]"
    },
    ...
  ],
  "certifications": [
    {
      "name": "[Certification1]",
      "issued": "[date]"
    },
    ...
  ]
}

Requirements:
Output Format:
Return the resume as a JSON object with the exact fields: name, contact, summary, experience, skills, education, certifications.

Ensure proper JSON syntax, including correct nesting and array structures.

Use the provided variables (e.g., ${user.full_name}, ${user.personal_email}) directly in the name and contact fields, as they are guaranteed to be available.

Contact Information:
Populate the contact object with:
email: ${user.personal_email}

phonenumber: ${user.phone}

linkedinURL: ${user.linkedin_url}

location: ${user.location}

github: ${user.github_url}

Do not modify or placeholder these fields, as they are guaranteed to be available.

Professional Summary:
Write a concise (3-4 sentences), impactful summary in the summary field.

Highlight the candidate's expertise, key technical skills, leadership, collaboration, and alignment with the job description (${jobDescription}).

Avoid generic phrases; tailor to the job's technical and business requirements.

Professional Experience:
Populate the experience array using ${formattedHistory} to extract company, dates, location, and position for each role.

For each experience entry, include 7-8 bullets with quantifiable achievements (e.g., "Reduced API latency by 40%," "Increased user engagement by 25%").

Ensure achievements are specific, measurable, and tied to real-world projects, avoiding generic or unsupported statistics.

Incorporate a wide range of technologies, tools, frameworks, programming languages, cloud platforms, APIs, and development methodologies, clearly explaining their application in projects.

Highlight contributions to user experience, performance optimization, security compliance, and business outcomes.

Showcase leadership, collaboration, and problem-solving skills through examples of cross-functional teamwork, mentoring, or initiative-taking.

For the first company in the experience array:
Create a unique, realistic, and innovative project aligned with the job description (${jobDescription}).

The project should be technically detailed, impactful, and demonstrate the use of relevant technologies (e.g., specific programming languages, frameworks, or cloud platforms).

Include a measurable outcome in one of the bullets (e.g., "Developed a microservices platform using Kubernetes, reducing processing time by 50%").

Ensure the project reflects collaboration, problem-solving, and alignment with the job's technical and business goals.

Skills:
Populate the skills array with at least two objects, each containing:
section: A category name (e.g., "Technical Skills," "Soft Skills," "Tools & Platforms").

list: An array of relevant skills (e.g., ["Python", "JavaScript", "AWS"] for Technical Skills).

Include a balanced mix of technical skills (e.g., programming languages, frameworks, cloud platforms, tools) and soft skills (e.g., leadership, communication, problem-solving).

Ensure skills align with the job description (${jobDescription}) without overloading keywords.

Avoid duplication across sections; group related skills logically.

Education:
Populate the education array using ${formattedEducation} to extract school, location, dates, and program for each entry.

Ensure each entry is structured as a JSON object with these fields.

Maintain consistent date formatting (e.g., "MM/YYYY - MM/YYYY" or "YYYY").

Certifications:
Populate the certifications array with relevant certifications, if available, using the format:
name: Certification name (e.g., "AWS Certified Solutions Architect").

issued: Issue date (e.g., "MM/YYYY").

Prioritize certifications related to the job description (e.g., cloud, Agile, or programming certifications).

Additional Guidelines:
Avoid keyword stuffing; ensure technologies and skills are contextually relevant to the job description and the candidate's experience.

Use action-oriented language in bullets (e.g., "Developed," "Optimized," "Led") to describe contributions.

Ensure a mix of technical expertise (e.g., coding, system design, DevOps) and soft skills (e.g., collaboration, communication) to create a balanced, professional narrative.

Maintain technical depth by explaining how tools or methodologies were applied (e.g., "Used Docker and Kubernetes to orchestrate a scalable microservices architecture").

Ensure all achievements are realistic and grounded in the context of the role and industry.

Validate that the JSON object is well-formed and adheres to the specified structure.

Assumptions:
All variables (${user.full_name}, ${user.location}, ${user.phone}, ${user.personal_email}, ${user.linkedin_url}, ${user.github_url}, ${formattedHistory}, ${formattedEducation}, ${jobDescription}) are available and should be used as provided.

The job description (${jobDescription}) provides sufficient context to tailor the resume's content, including required technologies, skills, and responsibilities.

Dates in ${formattedHistory} and ${formattedEducation} are formatted consistently (e.g., "MM/YYYY - MM/YYYY" or "YYYY").

If ${user.github_url} is empty or not applicable, include it as an empty string ("") in the contact object.

`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-2025-04-14",
      messages: [
        {
          role: "system",
          content: "You are a professional resume writer with expertise in creating tailored resumes for job applications. You excel at crafting authentic, detailed, and impactful resumes that highlight the candidate's unique strengths and experiences. Always respond with valid JSON."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.5,
      max_tokens: 30000,
      presence_penalty: 0.3,
      frequency_penalty: 0.2,
      response_format: { type: "json_object" }
    });

    // Extract the resume content from the API response
    const generatedResume = JSON.parse(completion.choices[0].message.content);
    
    // Initialize the resume data structure
    const resumeData = {
      name: user.full_name,
      contact: {
        email: user.personal_email || '',
        phonenumber: user.phone || '',
        linkedinURL: user.linkedin_url || '',
        location: user.location || '',
        github: user.github_url || ''
      },
      summary: generatedResume.summary,
      experience: generatedResume.experience,
      skills: generatedResume.skills,
      education: generatedResume.education,
      certifications: generatedResume.certifications
    };

    // Generate DOCX content
    const templatePath = path.join(__dirname, 'templates', 'resume-template.docx');
    const content = fs.readFileSync(templatePath, 'binary');
    const zip = new PizZip(content);
    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
    });

    const templateData = {
      name: resumeData.name || '',
      contact: `${resumeData.contact.email} | ${resumeData.contact.phonenumber} | ${resumeData.contact.linkedinURL} | ${resumeData.contact.github}`,
      summary: resumeData.summary || '',
      experience: resumeData.experience.map((exp, index) => ({
        company: clearedText(exp.company) || '',
        location: clearedText(exp.location) || '',
        position: clearedText(exp.position) || '',
        dates: clearedText(exp.dates) || '',
        bullets: exp.bullets || []
      })),
      skills: resumeData.skills?.map(skillSection => ({
        section: skillSection.section,
        list: skillSection.list
      })),
      education: resumeData.education?.map(edu => ({
        school: clearedText(edu.school) || '',
        location: clearedText(edu.location) || '',
        program: clearedText(edu.program) || '',
        dates: clearedText(edu.dates) || ''
      })),
      certifications: resumeData.certifications?.map(cert => ({
        name: clearedText(cert.name) || '',
        issued: clearedText(cert.issued) || ''
      }))
    };

    // Render the document
    doc.render(templateData);

    // Generate the output
    const buffer = doc.getZip().generate({
      type: 'nodebuffer',
      compression: 'DEFLATE'
    });

    // Convert buffer to base64
    const base64Content = buffer.toString('base64');
    
    res.json({
      resume: resumeData,
      generatedResume,
      docxContent: base64Content
    });
  } catch (error) {
    console.error('Error generating resume:', error);
    res.status(500).json({ error: 'Failed to generate resume' });
  }
});

// Token verification endpoint
app.get('/api/auth/verify', auth, async (req, res) => {
  try {
    const user = await User.findByEmail(req.user.email);
    if (!user) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    
    // Remove sensitive data
    delete user.password;
    
    res.json({ user });
  } catch (error) {
    console.error('Token verification error:', error);
    res.status(500).json({ error: 'Failed to verify token' });
  }
});

const clearedText = (text) => {
  if (!text) return '';
  // Remove quotation marks and whitespace characters
  return text.replace(/^["']|["']$/g, '').replace(/[\n\r\t\f\v]/g, '').trim();
}

// Download endpoints
app.post('/api/download/:format', async (req, res) => {
  try {
    const { format } = req.params;
    const { resume } = req.body;

    if (!resume) {
      return res.status(400).json({ error: 'Resume content is required' });
    }

    // Use the resume data object directly
    const resumeData = resume;

    if (format === 'docx') {
      try {
        // Read the template file
        const templatePath = path.join(__dirname, 'templates', 'resume-template.docx');
        const content = fs.readFileSync(templatePath, 'binary');
        
        // Create a new instance of PizZip
        const zip = new PizZip(content);
        
        // Create a new instance of Docxtemplater
        const doc = new Docxtemplater(zip, {
          paragraphLoop: true,
          linebreaks: true,
        });

        // Prepare the data for the template
        console.log({certifications: resumeData.certifications})
        const templateData = {
          name: resumeData.name || '',
          contact: `${resumeData.contact.email} | ${resumeData.contact.phonenumber} | ${resumeData.contact.linkedinURL} | ${resumeData.contact.github}`,
          summary: resumeData.summary || '',
          experience: resumeData.experience.map((exp, index) => ({
            company: clearedText(exp.company) || '',
            location: clearedText(exp.location) || '',
            position: clearedText(exp.position) || '',
            dates: clearedText(exp.dates) || '',
            bullets: exp.bullets || []
          })),
          skills: resumeData.skills.map(skillSection => ({
            section: skillSection.section,
            list: skillSection.list
          })),
          education: resumeData.education.map(edu => ({
            school: clearedText(edu.school) || '',
            location: clearedText(edu.location) || '',
            program: clearedText(edu.program) || '',
            dates: clearedText(edu.dates) || ''
          })),
          certifications: resumeData.certifications.map(cert => ({
            name: clearedText(cert.name) || '',
            issued: clearedText(cert.issued) || ''
          }))
        };

        // Render the document
        doc.render(templateData);

        // Generate the output
        const buffer = doc.getZip().generate({
          type: 'nodebuffer',
          compression: 'DEFLATE'
        });
        
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', 'attachment; filename=resume.docx');
        res.send(buffer);
      } catch (error) {
        console.error('Document generation error:', error);
        res.status(500).json({ error: 'Failed to generate document' });
      }
    } else if (format === 'pdf') {
      // Create PDF
      const doc = new PDFDocument({
        size: 'A4',
        margin: 50
      });

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename=resume.pdf');
      doc.pipe(res);

      // Set default font
      doc.font('Helvetica');

      // Name (Header)
      doc.fontSize(24)
         .font('Helvetica-Bold')
         .text(resumeData.name || '', { align: 'center' })
         .moveDown(0.5);

      // Contact information
      const contactInfo = [
        resumeData.contact.email,
        resumeData.contact.phonenumber,
        resumeData.contact.linkedinURL,
        resumeData.contact.github
      ].filter(Boolean).join(' | ');

      doc.fontSize(11)
         .font('Helvetica')
         .text(contactInfo, { align: 'center' })
         .moveDown(1);

      // Professional Summary
      doc.fontSize(14)
         .font('Helvetica-Bold')
         .text('Professional Summary')
         .moveDown(0.5);

      doc.fontSize(11)
         .font('Helvetica')
         .text(resumeData.summary || '')
         .moveDown(1);

      // Professional Experience
      doc.fontSize(14)
         .font('Helvetica-Bold')
         .text('Professional Experience')
         .moveDown(0.5);

      if (resumeData.experience && Array.isArray(resumeData.experience)) {
        resumeData.experience.forEach(exp => {
          // Company and Location
          doc.fontSize(12)
             .font('Helvetica-Bold')
             .text(`${exp.company}, ${exp.location}`)
             .moveDown(0.5);

          // Position and Dates
          doc.fontSize(11)
             .font('Helvetica')
             .text(`${exp.position} (${exp.dates})`)
             .moveDown(0.5);

          // Bullet points
          if (exp.bullets && Array.isArray(exp.bullets)) {
            exp.bullets.forEach(bullet => {
              doc.fontSize(11)
                 .font('Helvetica')
                 .text(`• ${bullet}`, {
                   indent: 20,
                   align: 'left'
                 })
                 .moveDown(0.5);
            });
          }

          doc.moveDown(0.5);
        });
      }

      // Skills
      doc.fontSize(14)
         .font('Helvetica-Bold')
         .text('Skills & Other')
         .moveDown(0.5);

      if (resumeData.skills && Array.isArray(resumeData.skills)) {
        resumeData.skills.forEach(skillSection => {
          doc.fontSize(12)
             .font('Helvetica-Bold')
             .text(skillSection.section)
             .moveDown(0.5);

          doc.fontSize(11)
             .font('Helvetica')
             .text(skillSection.list.join(', '))
             .moveDown(0.5);
        });
      }

      doc.moveDown(1);

      // Education
      doc.fontSize(14)
         .font('Helvetica-Bold')
         .text('Education')
         .moveDown(0.5);

      if (resumeData.education && Array.isArray(resumeData.education)) {
        resumeData.education.forEach(edu => {
          doc.fontSize(12)
             .font('Helvetica-Bold')
             .text(`${edu.school}, ${edu.location}`)
             .moveDown(0.5);

          doc.fontSize(11)
             .font('Helvetica')
             .text(`${edu.program} (${edu.dates})`)
             .moveDown(0.5);
        });
      }

      doc.moveDown(1);

      // Certifications
      if (resumeData.certifications && Array.isArray(resumeData.certifications) && resumeData.certifications.length > 0) {
        doc.fontSize(14)
           .font('Helvetica-Bold')
           .text('Certifications')
           .moveDown(0.5);

        resumeData.certifications.forEach(cert => {
          doc.fontSize(12)
             .font('Helvetica-Bold')
             .text(cert.name)
             .moveDown(0.5);

          doc.fontSize(11)
             .font('Helvetica')
             .text(`Issued ${cert.issued}`)
             .moveDown(0.5);
        });
      }

      doc.end();
    } else {
      res.status(400).json({ error: 'Invalid format' });
    }
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ error: 'Failed to generate document' });
  }
});

// Add new endpoint for DOCX to PDF conversion
app.post('/api/convert-to-pdf', auth, upload.single('docx'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No DOCX file provided' });
    }

    // Convert DOCX to PDF using libreoffice-convert
    const pdfBuffer = await convertAsync(req.file.buffer, '.pdf', undefined);

    // Set response headers
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=resume.pdf');

    // Send the PDF
    res.send(pdfBuffer);
  } catch (error) {
    console.error('Error converting DOCX to PDF:', error);
    res.status(500).json({ error: 'Failed to convert DOCX to PDF' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Handle React routing, return all requests to React app
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../../frontend/build', 'index.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: 'Something went wrong!' });
});

// Start HTTP server
app.listen(port, host, () => {
  console.log(`HTTP server is running on http://${host}:${port}`);
}); 