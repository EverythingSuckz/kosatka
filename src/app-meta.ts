/**
 * App identity in one place: name, version, author, and the GitHub links the
 * About panel and the feedback / report-issue buttons point at.
 *
 * REPO_URL is the single source of truth for every GitHub link. ISSUES_URL and
 * NEW_ISSUE_URL derive from it, so updating REPO_URL once the repository is
 * public makes every link follow. NEW_ISSUE_URL picks up an issue template
 * automatically once one exists under .github/ISSUE_TEMPLATE.
 */

export const APP_NAME = 'kosatka'
/** Short descriptor shown next to the wordmark (e.g. header, about). */
export const APP_TAGLINE = 'stem mixer'
export const APP_VERSION = '0.1.0'
export const APP_AUTHOR = 'wrench'

export const REPO_URL = 'https://github.com/EverythingSuckz/kosatka'
export const ISSUES_URL = `${REPO_URL}/issues`
export const NEW_ISSUE_URL = `${REPO_URL}/issues/new`
