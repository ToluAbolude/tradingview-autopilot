// cv_profile.mjs — Tolu Abolude's structured CV for job matching
export const CV = {
  name:  'Tolu Abolude',
  email: 'toludavid07@gmail.com',
  phone: '+447475481278',

  experience_years: 4,
  current_role:     'Software Engineer at Netcompany (NHS/HMRC)',
  education:        'MSci Computer Science, University of Exeter (2:1)',

  target: {
    salary_min: 55000,
    salary_max: 120000,
    currency:   'GBP',
    locations:  ['London', 'Remote', 'Hybrid', 'United Kingdom'],
    roles: [
      'Software Engineer', 'Backend Engineer', 'Full Stack Engineer',
      'Java Developer', 'Python Developer', 'API Developer',
      'Cloud Engineer', 'DevOps Engineer', 'Platform Engineer',
      'Software Developer', 'Senior Software Engineer',
      'Data Engineer', 'Solutions Engineer', 'Systems Engineer',
    ],
  },

  skills: {
    // Scored by proficiency — used for job matching
    languages:    ['Java', 'Python', 'JavaScript', 'Bash', 'C++', 'HTML', 'CSS', 'Ansible', 'Terraform', 'Gherkin', 'SQL'],
    frameworks:   ['Spring Boot', 'Maven', 'Cucumber', 'Pydantic', 'JUnit', 'Pytest', 'TensorFlow'],
    cloud:        ['AWS', 'Azure', 'AWS Lambda', 'AWS DynamoDB', 'AWS Neptune', 'Azure PaaS', 'Azure CI/CD'],
    devops:       ['Docker', 'Kubernetes', 'Jenkins', 'CI/CD', 'GitHub Actions', 'Git'],
    messaging:    ['RabbitMQ'],
    databases:    ['MySQL', 'PostgreSQL', 'DynamoDB', 'Neptune', 'NoSQL'],
    tools:        ['Jira', 'Confluence', 'Grafana', 'Postman', 'SOAP UI', 'JMeter', 'GitHub'],
    methodologies:['Agile', 'BDD', 'TDD', 'Scrum', 'Kanban', 'Pair Programming', 'Code Review'],
    apis:         ['REST', 'FHIR R4', 'API Design', 'Microservices', 'RabbitMQ', 'OpenAPI'],
    concepts:     ['MVC', 'Microservices', 'Incident Management', 'On-call', 'P1/P2/P3 incidents'],
  },

  // All skills flat list for quick matching
  all_skills: [
    'Java', 'Python', 'JavaScript', 'Bash', 'C++', 'HTML', 'CSS', 'Ansible', 'Terraform',
    'Spring Boot', 'Maven', 'Cucumber', 'Pydantic', 'JUnit', 'Pytest', 'TensorFlow',
    'AWS', 'Azure', 'Lambda', 'DynamoDB', 'Neptune', 'AWS Lambda',
    'Docker', 'Kubernetes', 'Jenkins', 'CI/CD', 'Git', 'GitHub',
    'RabbitMQ', 'MySQL', 'PostgreSQL', 'NoSQL',
    'Jira', 'Confluence', 'Grafana', 'Postman',
    'REST', 'FHIR', 'API', 'Microservices',
    'Agile', 'BDD', 'TDD', 'Scrum', 'Kanban',
  ],

  highlights: [
    'Led FHIR R4 API design for NHS systems (80M+ records)',
    'AWS Lambda + Neptune/DynamoDB at scale',
    'Java/Kubernetes/RabbitMQ for HMRC APIs',
    'Azure CI/CD pipelines, Jenkins deployments',
    'Incident management, on-call, P1/P2/P3 response',
    'Agile delivery across government clients',
  ],

  summary: `Software Engineer with 4 years experience in backend API development, cloud infrastructure, and government-scale systems. Strong in Java, Python, AWS, and Azure. Delivered FHIR R4 APIs for NHS processing 80M+ records, designed HMRC APIs, and managed Azure/Jenkins CI/CD pipelines. Experienced in agile teams, BDD testing, and incident management.`,
};

// Job search queries — run in sequence to cover all relevant roles
export const SEARCH_QUERIES = [
  'software engineer java',
  'backend engineer python',
  'cloud engineer aws azure',
  'java developer spring boot',
  'api developer backend',
  'devops engineer kubernetes',
  'platform engineer cloud',
  'software developer java python',
  'python developer backend',
  'full stack engineer',
];
