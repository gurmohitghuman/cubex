// findymail.search.employees, as Findymail answers it (its catalog entry): the people at a website holding the job
// titles asked for, `count` of them (default 1, at most 3), as [{name, linkedinUrl, companyWebsite, companyName,
// jobTitle}], billed per person returned. A website naming "nobody" has none: [] and free. Made-up people: one per
// title, in order, named after the website.
export const isEmployeeSearch = toolId => toolId === 'findymail.search.employees'

const FIRST = ['Dana', 'Lee', 'Sam']
const cap = s => s.charAt(0).toUpperCase() + s.slice(1)

export function employeesAnswer(body) {
  const site = String(body.website ?? '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]
  const titles = Array.isArray(body.job_titles) ? body.job_titles.filter(t => typeof t === 'string' && t) : []
  if (!site || site.includes('nobody') || titles.length === 0) return []
  const count = Math.min(Math.max(Number.parseInt(body.count, 10) || 1, 1), 3)
  const stem = site.split('.')[0].replace(/[^a-z0-9]/g, '') || 'acme'
  return titles.slice(0, count).map((title, i) => ({
    name: `${FIRST[i]} ${cap(stem)}`, linkedinUrl: `https://www.linkedin.com/in/${FIRST[i].toLowerCase()}-${stem}`,
    companyWebsite: site, companyName: cap(stem), jobTitle: title,
  }))
}
