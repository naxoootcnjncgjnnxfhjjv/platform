import attachment, { type Attachment } from '@hcengineering/attachment'
import core, {
  type AttachedData,
  type CollaborativeDoc,
  collaborativeDocParse,
  type Data,
  generateId,
  makeCollaborativeDoc,
  type Mixin,
  type Ref,
  SortingOrder,
  type Timestamp,
  type TxOperations,
  type DocumentQuery,
  type Status,
  type Account,
  type Doc,
  type Blob as PlatformBlob
} from '@hcengineering/core'
import { type FileUploader } from './uploader'
import task, {
  createProjectType,
  makeRank,
  type TaskTypeWithFactory,
  type ProjectType,
  type TaskType
} from '@hcengineering/task'
import document, { type Document, type Teamspace, getFirstRank } from '@hcengineering/document'
import { jsonToMarkup, jsonToYDocNoSchema, parseMessageMarkdown, type MarkupNode } from '@hcengineering/text'
import { yDocToBuffer } from '@hcengineering/collaboration'
import { type Person } from '@hcengineering/contact'
import tracker, {
  type Issue,
  type IssueParentInfo,
  IssuePriority,
  type IssueStatus,
  type Project,
  TimeReportDayType
} from '@hcengineering/tracker'
import chunter, { type ChatMessage } from '@hcengineering/chunter'

export interface ImportWorkspace {
  persons?: ImportPerson[]
  projectTypes?: ImportProjectType[]
  spaces?: ImportSpace<ImportDoc>[]
}

export interface ImportPerson {
  name: string
  email: string
}

export interface ImportProjectType {
  name: string
  taskTypes?: ImportTaskType[]
  description?: string
}

export interface ImportTaskType {
  name: string
  statuses: ImportStatus[]
  description?: string
}

export interface ImportStatus {
  name: string
  description?: string
}

export interface ImportSpace<T extends ImportDoc> {
  class: string
  name: string
  description?: string
  // members?: ImportPerson[] // todo: person vs account

  docs: T[]
}
export interface ImportDoc {
  class: string
  title: string
  descrProvider: () => Promise<string>

  subdocs: ImportDoc[]
}

export interface ImportTeamspace extends ImportSpace<ImportDocument> {
  class: 'document.class.TeamSpace'
}

export interface ImportDocument extends ImportDoc {
  class: 'document.class.Document'
  subdocs: ImportDocument[]
}

export interface ImportProject extends ImportSpace<ImportIssue> {
  class: 'tracker.class.Project'
  identifier: string
  private: boolean
  autoJoin: boolean
  projectType: ImportProjectType
  defaultAssignee?: ImportPerson
  defaultIssueStatus?: ImportStatus
  owners?: ImportPerson[]
  members?: ImportPerson[]
  description?: string
}

export interface ImportIssue extends ImportDoc {
  class: 'tracker.class.Issue'
  status: ImportStatus
  assignee?: Ref<Person>
  estimation?: number
  remainingTime?: number
  comments?: ImportComment[]
}

export interface ImportComment {
  text: string
  author?: Ref<Account>// todo: person vs account
  date?: Timestamp
  attachments?: ImportAttachment[]
}

export interface ImportAttachment {
  title: string
  blobProvider: () => Promise<Blob | null>
}

export interface MarkdownPreprocessor {
  process: (json: MarkupNode) => MarkupNode
}

// todo: move to fileUploader
interface UploadResult {
  key: 'file'
  id: Ref<PlatformBlob>
}

export class WorkspaceImporter {
  private readonly personsByName = new Map<string, Ref<Person>>()
  private readonly issueStatusByName = new Map<string, Ref<IssueStatus>>()
  private readonly projectTypeByName = new Map<string, Ref<ProjectType>>()

  constructor (
    private readonly client: TxOperations,
    private readonly fileUploader: FileUploader,
    private readonly workspaceData: ImportWorkspace,
    private readonly preprocessor: MarkdownPreprocessor
  ) {}

  public async performImport (): Promise<void> {
    await this.importPersons()
    await this.importProjectTypes()
    await this.importSpaces()
  }

  private async importPersons (): Promise<void> {
    if (this.workspaceData.persons === undefined) return

    for (const person of this.workspaceData.persons) {
      const personId = generateId<Person>()
      this.personsByName.set(person.name, personId)
      // TODO: Implement person creation
    }
  }

  private async importProjectTypes (): Promise<void> {
    if (this.workspaceData.projectTypes === undefined) return

    for (const projectType of this.workspaceData.projectTypes) {
      const projectTypeId = await this.createProjectTypeWithTaskTypes(projectType)
      this.projectTypeByName.set(projectType.name, projectTypeId)
    }
  }

  private async importSpaces (): Promise<void> {
    if (this.workspaceData.spaces === undefined) return

    for (const space of this.workspaceData.spaces) {
      if (space.class === 'document.class.TeamSpace') {
        await this.importTeamspace(space as ImportTeamspace)
      } else if (space.class === 'tracker.class.Project') {
        await this.importProject(space as ImportProject)
      }
    }
  }

  async createProjectTypeWithTaskTypes (projectType: ImportProjectType): Promise<Ref<ProjectType>> {
    const taskTypes: TaskTypeWithFactory[] = []
    if (projectType.taskTypes !== undefined) {
      for (const taskType of projectType.taskTypes) {
        const taskTypeId = generateId<TaskType>()
        const statuses = taskType.statuses.map((status) => {
          return {
            name: status.name,
            ofAttribute: tracker.attribute.IssueStatus,
            category: task.statusCategory.Active // todo: Unsorted?
          }
        })
        taskTypes.push({
          _id: taskTypeId,
          descriptor: tracker.descriptors.Issue,
          kind: 'both',
          name: taskType.name,
          ofClass: tracker.class.Issue,
          statusCategories: [task.statusCategory.Active],
          statusClass: tracker.class.IssueStatus,
          icon: tracker.icon.Issue,
          color: 0,
          allowedAsChildOf: [taskTypeId],
          factory: statuses
        })
      }
    }
    const projectData = {
      name: projectType.name,
      descriptor: tracker.descriptors.ProjectType,
      shortDescription: projectType.description,
      description: '', // put the description as shortDescription, so the users can see it
      tasks: [],
      roles: 0,
      classic: true
    }
    return await createProjectType(this.client, projectData, taskTypes, generateId())
  }

  async importTeamspace (space: ImportTeamspace): Promise<Ref<Teamspace>> {
    const teamspaceId = await this.createTeamspace(space)
    for (const doc of space.docs) {
      await this.createDocumentWithSubdocs(doc, document.ids.NoParent, teamspaceId)
    }
    return teamspaceId
  }

  async createDocumentWithSubdocs (
    doc: ImportDocument,
    parentId: Ref<Document>,
    teamspaceId: Ref<Teamspace>
  ): Promise<Ref<Document>> {
    const documentId = await this.createDocument(doc, parentId, teamspaceId)
    for (const child of doc.subdocs) {
      await this.createDocumentWithSubdocs(child, documentId, teamspaceId)
    }
    return documentId
  }

  async createTeamspace (space: ImportTeamspace): Promise<Ref<Teamspace>> {
    const teamspaceId = generateId<Teamspace>()
    const data = {
      type: document.spaceType.DefaultTeamspaceType,
      description: space.description ?? '',
      title: space.name,
      name: space.name,
      private: false,
      members: [],
      owners: [],
      autoJoin: false,
      archived: false
    }
    await this.client.createDoc(document.class.Teamspace, core.space.Space, data, teamspaceId)
    return teamspaceId
  }

  async createDocument (
    doc: ImportDocument,
    parentId: Ref<Document>,
    teamspaceId: Ref<Teamspace>
  ): Promise<Ref<Document>> {
    const id = generateId<Document>()
    const content = await doc.descrProvider()
    const collabId = await this.createCollaborativeContent(id, 'content', content)

    const lastRank = await getFirstRank(this.client, teamspaceId, parentId)
    const rank = makeRank(lastRank, undefined)

    const attachedData: Data<Document> = {
      title: doc.title,
      content: collabId,
      parent: parentId,
      attachments: 0,
      embeddings: 0,
      labels: 0,
      comments: 0,
      references: 0,
      rank
    }

    await this.client.createDoc(document.class.Document, teamspaceId, attachedData, id)
    return id
  }

  async importProject (project: ImportProject): Promise<Ref<Project>> {
    console.log('Create project: ', project.name)
    const projectId = await this.createProject(project)
    console.log('Project created: ' + projectId)

    const projectDoc = await this.client.findOne(tracker.class.Project, { _id: projectId })
    if (projectDoc === undefined) {
      throw new Error('Project not found: ' + projectId)
    }

    for (const issue of project.docs) {
      await this.createIssueWithSubissues(issue, tracker.ids.NoParent, projectDoc, [])
    }
    return projectId
  }

  async createIssueWithSubissues (
    issue: ImportIssue,
    parentId: Ref<Issue>,
    project: Project,
    parentsInfo: IssueParentInfo[]
  ): Promise<{ id: Ref<Issue>, identifier: string }> {
    console.log('Create issue: ', issue.title)
    const issueResult = await this.createIssue(issue, project, parentId, parentsInfo)
    console.log('Issue created: ', issueResult)

    if (issue.subdocs.length > 0) {
      const parentsInfoEx = [
        {
          parentId: issueResult.id,
          parentTitle: issue.title,
          space: project._id,
          identifier: issueResult.identifier
        },
        ...parentsInfo
      ]

      for (const child of issue.subdocs) {
        await this.createIssueWithSubissues(child as ImportIssue, issueResult.id, project, parentsInfoEx)
      }
    }

    return issueResult
  }

  async createProject (project: ImportProject): Promise<Ref<Project>> {
    const projectId = generateId<Project>()
    const projectType = this.projectTypeByName.get(project.projectType.name)
    const defaultIssueStatus =
      project.defaultIssueStatus !== undefined
        ? this.issueStatusByName.get(project.defaultIssueStatus.name)
        : tracker.status.Backlog
    const identifier = await this.uniqueProjectIdentifier(project.identifier)
    const projectData = {
      name: project.name,
      description: project.description ?? '',
      private: project.private,
      members: [], // todo
      owners: [], // todo
      archived: false,
      autoJoin: project.autoJoin,
      identifier,
      sequence: 0,
      defaultIssueStatus: defaultIssueStatus ?? tracker.status.Backlog, // todo: test with no status
      defaultTimeReportDay: TimeReportDayType.PreviousWorkDay,
      type: projectType ?? generateId() // tracker.ids.ClassicProjectType // todo: fixme! handle project type is not set or created before the import
    }
    await this.client.createDoc(tracker.class.Project, core.space.Space, projectData, projectId)

    const mixinId = `${projectType}:type:mixin` as Ref<Mixin<Project>>
    await this.client.createMixin(projectId, tracker.class.Project, core.space.Space, mixinId, {})

    return projectId
  }

  async createIssue (
    issue: ImportIssue,
    project: Project,
    parentId: Ref<Issue>,
    parentsInfo: IssueParentInfo[]
  ): Promise<{ id: Ref<Issue>, identifier: string }> {
    const issueId = generateId<Issue>()
    const content = await issue.descrProvider()
    const collabId = await this.createCollaborativeContent(issueId, 'description', content)

    const { number, identifier } = await this.getNextIssueIdentifier(project)
    const kind = await this.getIssueKind(project)
    const rank = await this.getIssueRank(project)
    const status = await this.findIssueStatusByName(issue.status.name)

    const estimation = issue.estimation ?? 0
    const remainingTime = issue.remainingTime ?? 0
    const reportedTime = estimation - remainingTime

    const issueData: AttachedData<Issue> = {
      title: issue.title,
      description: collabId,
      assignee: issue.assignee ?? null,
      component: null,
      number,
      status,
      priority: IssuePriority.NoPriority, // todo
      rank,
      comments: issue.comments?.length ?? 0,
      subIssues: 0, // todo
      dueDate: null,
      parents: parentsInfo,
      remainingTime,
      estimation,
      reportedTime,
      reports: 0,
      childInfo: [],
      identifier,
      kind: kind._id
    }

    await this.client.addCollection(
      tracker.class.Issue,
      project._id,
      parentId,
      tracker.class.Issue,
      'subIssues',
      issueData,
      issueId
    )

    if (issue.comments !== undefined) {
      await this.importComments(issueId, issue.comments, project._id)
    }
    return { id: issueId, identifier }
  }

  private async getNextIssueIdentifier (project: Project): Promise<{ number: number, identifier: string }> {
    const incResult = await this.client.updateDoc(
      tracker.class.Project,
      core.space.Space,
      project._id,
      { $inc: { sequence: 1 } },
      true
    )
    const number = (incResult as any).object.sequence
    const identifier = `${project.identifier}-${number}`
    return { number, identifier }
  }

  private async getIssueKind (project: Project): Promise<TaskType> {
    const taskKind = project?.type !== undefined ? { parent: project.type } : {}
    const kind = await this.client.findOne(task.class.TaskType, taskKind)
    if (kind === undefined) {
      throw new Error(`Task type not found for project: ${project._id}`)
    }
    return kind
  }

  private async getIssueRank (project: Project): Promise<string> {
    const lastIssue = await this.client.findOne<Issue>(
      tracker.class.Issue,
      { space: project._id },
      { sort: { rank: SortingOrder.Descending } }
    )
    return makeRank(lastIssue?.rank, undefined)
  }

  private async importComments (issueId: Ref<Issue>, comments: ImportComment[], projectId: Ref<Project>): Promise<void> {
    const sortedComments = comments.sort((a, b) => {
      const now = Date.now()
      return (a.date ?? now) - (b.date ?? now)
    })
    for (const comment of sortedComments) {
      await this.createComment(issueId, comment, projectId)
    }
  }

  async createComment (issueId: Ref<Issue>, comment: ImportComment, projectId: Ref<Project>): Promise<void> {
    const json = parseMessageMarkdown(comment.text ?? '', 'image://')
    const processedJson = this.preprocessor.process(json)
    const markup = jsonToMarkup(processedJson)

    const value: AttachedData<ChatMessage> = {
      message: markup,
      attachments: comment.attachments?.length
    }

    const commentId = generateId<ChatMessage>()
    await this.client.addCollection(
      chunter.class.ChatMessage,
      projectId,
      issueId,
      tracker.class.Issue,
      'comments',
      value,
      commentId,
      comment.date,
      comment.author // todo: as Ref<Account>
    )

    if (comment.attachments !== undefined) {
      await this.importAttachments(commentId, comment.attachments, projectId)
    }
  }

  private async importAttachments (
    commentId: Ref<ChatMessage>,
    attachments: ImportAttachment[],
    projectId: Ref<Project>
  ): Promise<void> {
    for (const attach of attachments) {
      const blob = await attach.blobProvider()
      if (blob === null) {
        console.warn('Failed to download attachment file: ', attach.title)
        continue
      }

      const attachmentId = await this.createAttachment(blob, attach, projectId, commentId)
      if (attachmentId === null) {
        console.warn('Failed to upload attachment file: ', attach.title)
      }
    }
  }

  private async createAttachment (
    blob: Blob,
    attach: ImportAttachment,
    projectId: Ref<Project>,
    commentId: Ref<ChatMessage>
  ): Promise<Ref<Attachment> | null> {
    const attachmentId = generateId<Attachment>()
    const file = new File([blob], attach.title)

    const response = await this.uploadFile(attachmentId, attach.title, file)
    if (response.status === 200) {
      const responseText = await response.text()
      if (responseText !== undefined) {
        const uploadResult = JSON.parse(responseText) as UploadResult[]
        if (!Array.isArray(uploadResult) || uploadResult.length === 0) {
          return null
        }

        await this.client.addCollection(
          attachment.class.Attachment,
          projectId,
          commentId,
          chunter.class.ChatMessage,
          'attachments',
          {
            file: uploadResult[0].id,
            lastModified: Date.now(),
            name: file.name,
            size: file.size,
            type: file.type
          },
          attachmentId
        )
      }
    }
    return attachmentId
  }

  // Collaborative content handling
  private async createCollaborativeContent (
    id: Ref<Doc>,
    field: string,
    content: string
  ): Promise<CollaborativeDoc> {
    const json = parseMessageMarkdown(content ?? '', 'image://')
    const processedJson = this.preprocessor.process(json)
    const collabId = makeCollaborativeDoc(id, 'description')

    const yDoc = jsonToYDocNoSchema(processedJson, field)
    const buffer = yDocToBuffer(yDoc)

    await this.uploadCollaborativeDoc(id, collabId, buffer)
    return collabId
  }

  private async uploadCollaborativeDoc (
    id: Ref<Doc>,
    collabId: CollaborativeDoc,
    data: Buffer
  ): Promise<Response> {
    const file = new File([data], collabId)
    const { documentId } = collaborativeDocParse(collabId)
    return await this.uploadFile(id, documentId, file, 'application/ydoc')
  }

  // todo: move to fileUploader
  private async uploadFile (
    id: Ref<Doc>,
    name: string,
    file: File,
    contentType?: string
  ): Promise<Response> {
    const form = new FormData()
    form.append('file', file, name)
    form.append('type', contentType ?? file.type)
    form.append('size', file.size.toString()) // todo: file.size
    form.append('name', file.name)
    form.append('id', id)
    form.append('data', new Blob([file])) // todo: test new Blob([blob])

    return await this.fileUploader(id, form)
  }

  async findIssueStatusByName (name: string): Promise<Ref<IssueStatus>> {
    const query: DocumentQuery<Status> = {
      name,
      ofAttribute: tracker.attribute.IssueStatus,
      category: task.statusCategory.Active
    }

    const status = await this.client.findOne(tracker.class.IssueStatus, query)
    if (status === undefined) {
      throw new Error('Issue status not found: ' + name)
    }

    return status._id
  }

  async uniqueProjectIdentifier (baseIdentifier: string): Promise<string> {
    const projects = await this.client.findAll(tracker.class.Project, {})
    const projectsIdentifiers = new Set(projects.map(({ identifier }) => identifier))

    let identifier = baseIdentifier
    let i = 1
    while (projectsIdentifiers.has(identifier)) {
      identifier = `${baseIdentifier}${i}`
      i++
    }
    return identifier
  }
}
