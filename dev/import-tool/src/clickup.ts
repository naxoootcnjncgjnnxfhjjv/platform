import contact, { type Person, type PersonAccount } from '@hcengineering/contact'
import { type Ref, type Timestamp, type TxOperations } from '@hcengineering/core'
import { MarkupNodeType, traverseNode, type MarkupNode } from '@hcengineering/text'
import csv from 'csvtojson'
import { readFile } from 'fs/promises'
import { parse } from 'path'
import { download } from './importer/dowloader'
import {
  WorkspaceImporter,
  type ImportComment,
  type ImportDocument,
  type ImportIssue,
  type ImportProject,
  type ImportProjectType,
  type MarkdownPreprocessor
} from './importer/importer'
import { type FileUploader } from './importer/uploader'

interface ClickupTask {
  'Task ID': string
  'Task Name': string
  'Task Content': string
  Status: string
  'Parent ID': string
  Attachments: string
  Assignees: string
  Priority?: number
  'Space Name': string
  Checklists: string // todo: obj
  Comments: string // todo: obj[]
  'Time Estimated': number
  'Time Spent': number
}

interface ClickupComment {
  by: string
  date: Timestamp
  text: string
}

interface ClickupAttachment {
  title: string
  url: string
}

interface ImportIssueEx extends ImportIssue {
  clickupParentId?: string
  clickupProjectName?: string
}

class ClickupMarkdownPreprocessor implements MarkdownPreprocessor {
  private readonly MENTION_REGEX = /@([A-Za-z]+ [A-Za-z]+)/g
  constructor (private readonly personsByName: Map<string, Ref<Person>>) {}

  process (json: MarkupNode): MarkupNode {
    traverseNode(json, (node) => {
      if (node.type === MarkupNodeType.paragraph && node.content !== undefined) {
        const newContent: MarkupNode[] = []
        for (const childNode of node.content) {
          if (childNode.type === MarkupNodeType.text && childNode.text !== undefined) {
            let match
            let lastIndex = 0
            let hasMentions = false

            while ((match = this.MENTION_REGEX.exec(childNode.text)) !== null) {
              hasMentions = true
              if (match.index > lastIndex) {
                newContent.push({
                  type: MarkupNodeType.text,
                  text: childNode.text.slice(lastIndex, match.index),
                  marks: childNode.marks,
                  attrs: childNode.attrs
                })
              }

              const name = match[1]
              const personRef = this.personsByName.get(name)
              if (personRef !== undefined) {
                newContent.push({
                  type: MarkupNodeType.reference,
                  attrs: {
                    id: personRef,
                    label: name,
                    objectclass: contact.class.Person
                  }
                })
              } else {
                newContent.push({
                  type: MarkupNodeType.text,
                  text: match[0],
                  marks: childNode.marks,
                  attrs: childNode.attrs
                })
              }

              lastIndex = this.MENTION_REGEX.lastIndex
            }

            if (hasMentions) {
              if (lastIndex < childNode.text.length) {
                newContent.push({
                  type: MarkupNodeType.text,
                  text: childNode.text.slice(lastIndex),
                  marks: childNode.marks,
                  attrs: childNode.attrs
                })
              }
            } else {
              newContent.push(childNode)
            }
          } else {
            newContent.push(childNode)
          }
        }

        node.content = newContent
        return false
      }
      return true
    })

    return json
  }
}

interface TasksProcessResult {
  projects: ImportProject[]
  projectType: ImportProjectType
}

class ClickupImporter {
  private personsByName = new Map<string, Ref<Person>>()
  private accountsByEmail = new Map<string, Ref<PersonAccount>>()

  constructor (
    private readonly client: TxOperations,
    private readonly fileUploader: FileUploader
  ) {}

  async importClickUpTasks (file: string): Promise<void> {
    const projectTypes: ImportProjectType[] = []
    const spaces: ImportProject[] = []

    const projectsData = await this.processClickupTasks(file)
    projectTypes.push(projectsData.projectType)
    spaces.push(...projectsData.projects)

    const importData = {
      projectTypes,
      spaces
    }

    console.log('========================================')
    console.log('IMPORT DATA STRUCTURE: ', JSON.stringify(importData, null, 4))
    console.log('========================================')
    const postprocessor = new ClickupMarkdownPreprocessor(this.personsByName)
    await new WorkspaceImporter(this.client, this.fileUploader, importData, postprocessor).performImport()
    console.log('========================================')
    console.log('IMPORT SUCCESS ')
  }

  private async processTasksCsv (file: string, process: (json: ClickupTask) => Promise<void> | void): Promise<void> {
    const jsonArray = await csv().fromFile(file)
    for (const json of jsonArray) {
      const clickupTask = json as ClickupTask
      await process(clickupTask)
    }
  }

  private async processClickupTasks (file: string): Promise<TasksProcessResult> {
    await this.fillPersonsByNames()
    await this.fillAccountsByEmails()

    const projects = new Set<string>()
    const statuses = new Set<string>()
    const importIssuesByClickupId = new Map<string, ImportIssueEx>()
    await this.processTasksCsv(file, async (clickupTask) => {
      const importIssue = (await this.convertToImportIssue(clickupTask)) as ImportIssueEx
      importIssue.clickupParentId = clickupTask['Parent ID']
      importIssue.clickupProjectName = clickupTask['Space Name']
      importIssuesByClickupId.set(clickupTask['Task ID'], importIssue)

      projects.add(clickupTask['Space Name'])
      statuses.add(clickupTask.Status)
    })

    console.log(projects)
    console.log(statuses)

    const importProjectType = this.createClickupProjectType(Array.from(statuses))

    const importProjectsByName = new Map<string, ImportProject>()
    for (const projectName of projects) {
      const identifier = this.getProjectIdentifier(projectName)
      importProjectsByName.set(projectName, {
        class: 'tracker.class.Project',
        name: projectName,
        identifier,
        private: false,
        autoJoin: false,
        projectType: importProjectType,
        docs: []
      })
    }

    for (const [clickupId, issue] of importIssuesByClickupId) {
      if (issue.clickupParentId !== undefined && issue.clickupParentId !== 'null') {
        const parent = importIssuesByClickupId.get(issue.clickupParentId)
        if (parent === undefined) {
          throw new Error(`Parent not found: ${issue.clickupParentId} (for task: ${clickupId})`)
        }
        parent.subdocs.push(issue)
      } else if (issue.clickupProjectName !== undefined && issue.clickupProjectName !== 'null') {
        // todo: blank string
        const project = importProjectsByName.get(issue.clickupProjectName)
        if (project === undefined) {
          throw new Error(`Project not found: ${issue.clickupProjectName} (for task: ${clickupId})`)
        }
        project.docs.push(issue)
      } else {
        throw new Error(`Task cannot be imported: ${clickupId} (No parent)`)
      }
    }

    return {
      projects: Array.from(importProjectsByName.values()),
      projectType: importProjectType
    }
  }

  private async convertToImportIssue (
    clickup: ClickupTask
  ): Promise<ImportIssue> {
    const status = {
      name: clickup.Status
    }

    const content = this.fixClickupString(clickup['Task Content'])
    const checklists = this.convertChecklistsToMarkdown(clickup.Checklists)

    const estimation = this.millisecondsToHours(clickup['Time Estimated'])
    const remainingTime = estimation - this.millisecondsToHours(clickup['Time Spent'])

    const comments = this.convertToImportComments(clickup.Comments)
    const attachments = await this.convertAttachmentsToComment(clickup.Attachments)

    const separator = (content.trim() !== '' && checklists.trim() !== '' ? '\n\n---\n' : '')
    const description = `${content.trim()}${separator}${checklists.trim()}`

    let assignee
    const serviceComments: ImportComment[] = []
    if (clickup.Assignees !== undefined) {
      const assignees = clickup.Assignees
        .substring(1, clickup.Assignees.length - 1)
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name.length > 0)

      for (let i = 0; i < assignees.length && assignee === undefined; i++) {
        assignee = this.personsByName.get(assignees[i])
      }

      if (assignee === undefined && assignees.length > 0) {
        serviceComments.push(this.createAssigneesComment(assignees))
      }
    }

    return {
      class: 'tracker.class.Issue',
      title: clickup['Task Name'],
      descrProvider: () => {
        return Promise.resolve(description)
      },
      status,
      estimation,
      remainingTime,
      comments: comments.concat(attachments).concat(serviceComments),
      subdocs: [],
      assignee
    }
  }

  createAssigneesComment (assignees: string[]): ImportComment {
    return {
      text: `*ClickUp assignees: ${assignees.join(', ')}*`
    }
  }

  private convertToImportComments (clickup: string): ImportComment[] {
    return JSON.parse(clickup).map((comment: ClickupComment) => {
      const author = this.accountsByEmail.get(comment.by)
      return {
        text: author !== undefined ? comment.text : `${comment.text}\n\n*(comment by ${comment.by})*`,
        date: new Date(comment.date).getTime(),
        author
      }
    })
  }

  private async convertAttachmentsToComment (clickup: string): Promise<ImportComment[]> {
    const res: ImportComment[] = []
    const attachments: ClickupAttachment[] = JSON.parse(clickup)
    for (const attachment of attachments) {
      res.push({
        text: `ClickUp attachment link: [${attachment.title}](${attachment.url})`,
        attachments: [{
          title: attachment.title,
          blobProvider: async () => { return await download(attachment.url) } // todo: handle error (broken link, or no vpn)
        }]
      })
    }
    return res
  }

  private convertChecklistsToMarkdown (clickup: string): string {
    const checklists = JSON.parse(clickup)
    let huly: string = '\n'
    for (const [key, values] of Object.entries(checklists)) {
      huly += `**${key}**\n`
      for (const value of values as string[]) {
        huly += `* [ ] ${value} \n` // todo: test and fix for checked items
      }
      huly += '\n'
    }
    return huly
  }

  private async fillPersonsByNames (): Promise<void> {
    this.personsByName = (await this.client.findAll(contact.class.Person, {}))
      .map((person) => {
        return {
          _id: person._id,
          name: person.name.split(',').reverse().join(' ')
        }
      })
      .reduce((refByName, person) => {
        refByName.set(person.name, person._id)
        return refByName
      }, new Map())
  }

  private async fillAccountsByEmails (): Promise<void> {
    const accounts = await this.client.findAll(contact.class.PersonAccount, {})
    this.accountsByEmail = accounts.reduce((accountsByEmail, account) => {
      accountsByEmail.set(account.email, account._id)
      return accountsByEmail
    }, new Map())
  }

  private fixClickupString (content: string): string {
    return content === 'null' ? '' : content.replaceAll('\\n', '\n')
  }

  private millisecondsToHours (milliseconds: number): number {
    return milliseconds / (1000 * 60 * 60)
  }

  private getProjectIdentifier (projectName: string): string {
    return projectName.toUpperCase().replaceAll('-', '_').replaceAll(' ', '_').substring(0, 4)
  }

  private createClickupProjectType (taskStatuses: string[]): ImportProjectType {
    const statuses = taskStatuses.map((name) => {
      return {
        name
      }
    })
    return {
      name: 'ClickUp project',
      description: 'For issues imported from ClickUp',
      taskTypes: [
        {
          name: 'ClickUp issue',
          statuses
        }
      ]
    }
  }
}

export { ClickupImporter }
