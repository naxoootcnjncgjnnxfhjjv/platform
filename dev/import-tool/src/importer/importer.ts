import attachment from '@hcengineering/attachment'
import core, {
  type AttachedData,
  type CollaborativeDoc,
  collaborativeDocParse,
  type Data,
  Doc,
  generateId,
  makeCollaborativeDoc,
  type Mixin,
  ObjQueryType,
  type Ref,
  SortingOrder,
  type Timestamp,
  type TxOperations,
  type Blob as PlatformBlob
} from '@hcengineering/core'
import { type FileUploader } from '../fileUploader'
import task, {
  createProjectType,
  makeRank,
  type TaskTypeWithFactory,
  type ProjectType,
  type TaskType
} from '@hcengineering/task'
import document, { type Document, type Teamspace, getFirstRank } from '@hcengineering/document'
import { jsonToYDocNoSchema, parseMessageMarkdown } from '@hcengineering/text'
import { yDocToBuffer } from '@hcengineering/collaboration'
import { type Person } from '@hcengineering/contact'
import tracker, { type Issue, IssuePriority, type IssueStatus, type Project, TimeReportDayType } from '@hcengineering/tracker'
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
  assignee?: ImportPerson
  estimation?: number
  remainingTime?: number
  comments?: ImportComment[]
  collaborators?: ImportPerson[]
}

export interface ImportComment {
  text: string
  author: ImportPerson // todo: person vs account
  date?: Timestamp
  attachments?: ImportAttachment[]
}

export interface ImportAttachment {
  title: string
  blobProvider: () => Promise<Blob>
}

export class WorkspaceImporter {
  private readonly personsByName = new Map<string, Ref<Person>>()
  private readonly issueStatusByName = new Map<string, Ref<IssueStatus>>()
  private readonly projectTypeByName = new Map<string, Ref<ProjectType>>()

  constructor (
    private readonly client: TxOperations,
    private readonly fileUploader: FileUploader,
    private readonly workspaceData: ImportWorkspace
  ) {}

  public async performImport () {
    if (this.workspaceData.persons !== undefined) {
      for (const person of this.workspaceData.persons) {
        // todo create people
        this.personsByName.set(person.name, generateId())
      }
    }

    if (this.workspaceData.projectTypes !== undefined) {
      for (const projectType of this.workspaceData.projectTypes) {
        const projectTypeId = await this.importProjectType(projectType)
        this.projectTypeByName.set(projectType.name, projectTypeId)
      }
    }

    if (this.workspaceData.spaces !== undefined) {
      for (const space of this.workspaceData.spaces) {
        if (space.class === 'document.class.TeamSpace') {
          await this.importTeamspace(space as ImportTeamspace)
        } else if (space.class === 'tracker.class.Project') {
          await this.importProject(space as ImportProject)
        }
      }
    }
  }

  async importProjectType (projectType: ImportProjectType): Promise<Ref<ProjectType>> {
    const taskTypes: TaskTypeWithFactory[] = []
    if (projectType.taskTypes !== undefined) {
      for (const taskType of projectType.taskTypes) {
        const taskTypeId = generateId<TaskType>()
        const statuses = taskType.statuses.map((status) => {
          return {
            name: status.name,
            ofAttribute: tracker.attribute.IssueStatus,
            category: task.statusCategory.UnStarted     //todo: Unsorted?
          }
        })
        taskTypes.push({
          _id: taskTypeId,
          descriptor: tracker.descriptors.Issue,
          kind: 'both',
          name: taskType.name,
          ofClass: tracker.class.Issue,
          statusCategories: [task.statusCategory.UnStarted],
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
      await this.createDocumentsWithSubdocs(doc, document.ids.NoParent, teamspaceId)
    }
    return teamspaceId
  }

  async createDocumentsWithSubdocs (
    doc: ImportDocument,
    parentId: Ref<Document>,
    teamspaceId: Ref<Teamspace>
  ): Promise<Ref<Document>> {
    const documentId = await this.createDocument(doc, parentId, teamspaceId)
    for (const child of doc.subdocs) {
      await this.createDocumentsWithSubdocs(child, documentId, teamspaceId)
    }
    return documentId
  }

  async createTeamspace (space: ImportTeamspace): Promise<Ref<Teamspace>> {
    const teamspaceId = generateId<Teamspace>()
    const data = {
      type: document.spaceType.DefaultTeamspaceType,
      description: 'Imported from Notion',
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
    const md = await doc.descrProvider()
    const json = parseMessageMarkdown(md, 'image://')

    const id = generateId<Document>()
    const collabId = makeCollaborativeDoc(id, 'description')
    const yDoc = jsonToYDocNoSchema(json, 'content')
    const { documentId } = collaborativeDocParse(collabId)
    const buffer = yDocToBuffer(yDoc)

    const form = new FormData()
    const file = new File([new Blob([buffer])], doc.title)
    form.append('file', file, documentId)
    form.append('type', 'application/ydoc')
    form.append('size', buffer.length.toString())
    form.append('name', doc.title)
    form.append('id', id)
    form.append('data', new Blob([buffer])) // ?
    await this.fileUploader(id, form)

    const lastRank = await getFirstRank(this.client, teamspaceId, parentId)
    const rank = makeRank(lastRank, undefined)

    const attachedData: Data<Document> = {
      title: doc.title,
      description: collabId,
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
    const projectId = await this.createProject(project)
    for (const issue of project.docs) {
      await this.createIssueWithSubissues(issue, tracker.ids.NoParent, projectId)
    }
    return projectId
  }

  async createIssueWithSubissues (
    issue: ImportIssue,
    parentId: Ref<Issue>,
    projectId: Ref<Project>
  ): Promise<Ref<Issue>> {
    const issueId = await this.createIssue(issue, parentId, projectId)
    for (const child of issue.subdocs) {
      await this.createIssueWithSubissues(child as ImportIssue, issueId, projectId)
    }
    return issueId
  }

  async createProject (project: ImportProject): Promise<Ref<Project>> {
    const projectId = generateId<Project>()
    const projectType = this.projectTypeByName.get(project.projectType.name)
    const defaultIssueStatus =
      project.defaultIssueStatus !== undefined
        ? this.issueStatusByName.get(project.defaultIssueStatus.name)
        : tracker.status.Backlog
    const projectData = {
      name: project.name,
      description: project.description ?? '',
      private: project.private,
      members: [], // todo
      owners: [], // todo
      archived: false,
      autoJoin: project.autoJoin,
      identifier: project.identifier,
      sequence: 0,
      defaultIssueStatus: defaultIssueStatus ?? tracker.status.Backlog, // todo: test with no status
      defaultTimeReportDay: TimeReportDayType.PreviousWorkDay,
      type: projectType ?? generateId() // tracker.ids.ClassicProjectType // todo: fixme! handle project type is not set or created before the import
    }
    await this.client.createDoc(tracker.class.Project, core.space.Space, projectData, projectId)
    // Add space type's mixin with roles assignments
    // const CLICKUP_MIXIN_ID = `${CLICKUP_TASK_TYPE_ID}:type:mixin` as Ref<Class<Task>>
    const mixinId = `${this.projectTypeByName.get(project.projectType.name)}:type:mixin` as Ref<Mixin<Project>>
    await this.client.createMixin(projectId, tracker.class.Project, core.space.Space, mixinId, {})
    return projectId
  }

  async createIssue (issue: ImportIssue, parentId: Ref<Issue>, projectId: Ref<Project>): Promise<Ref<Issue>> {
    const issueId = generateId<Issue>()
    const lastOne = await this.client.findOne<Issue>(
      tracker.class.Issue,
      { space: projectId },
      { sort: { rank: SortingOrder.Descending } }
    )
    const incResult = await this.client.updateDoc(
      tracker.class.Project,
      core.space.Space,
      projectId,
      {
        $inc: { sequence: 1 }
      },
      true
    )

    const proj = await this.client.findOne(tracker.class.Project, { _id: projectId })
    const number = (incResult as any).object.sequence
    const identifier = `${proj?.identifier}-${number}`

    const taskKind = proj?.type !== undefined ? { parent: proj.type } : {}
    const kind = (await this.client.findOne(task.class.TaskType, taskKind)) as TaskType

    const collabId = await this.importIssueDescription(issueId, await issue.descrProvider())

    const status = this.issueStatusByName.get(issue.status.name)
    const taskToCreate = {
      title: issue.title,
      description: collabId,
      assignee: null, // todo: Ref<Person>
      component: null,
      number,
      status: status!,
      priority: IssuePriority.NoPriority, // todo
      rank: makeRank(lastOne?.rank, undefined),
      comments: issue.comments?.length ?? 0,
      subIssues: 0, // todo
      dueDate: null,
      parents: [], // todo
      reportedTime: 0,
      remainingTime: issue.remainingTime ?? 0,
      estimation: issue.estimation ?? 0,
      reports: 0,
      childInfo: [],
      identifier,
      kind: kind._id
    }
    await this.client.addCollection(
      tracker.class.Issue,
      projectId,
      tracker.ids.NoParent,
      tracker.class.Issue,
      'subIssues',
      taskToCreate,
      issueId
    )

    if (issue.comments !== undefined) {
      for (const comment of issue.comments) {
        await this.importComment(issueId, comment, projectId)
      }
    }
    return issueId
  }

  async importIssueDescription (id: Ref<Issue>, data: string): Promise<CollaborativeDoc> {
    const json = parseMessageMarkdown(data ?? '', 'image://')
    const collabId = makeCollaborativeDoc(id, 'description')

    const yDoc = jsonToYDocNoSchema(json, 'description')
    const { documentId } = collaborativeDocParse(collabId)
    const buffer = yDocToBuffer(yDoc)

    const form = new FormData()
    const file = new File([new Blob([buffer])], collabId)
    form.append('file', file, documentId)
    form.append('type', 'application/ydoc')
    form.append('size', buffer.length.toString())
    form.append('name', collabId)
    form.append('id', id)
    form.append('data', new Blob([buffer])) // ?

    await this.fileUploader(id, form)

    return collabId
  }

  async importComment (issueId: Ref<Issue>, comment: ImportComment, projectId: Ref<Project>): Promise<void> {
    const commentId = generateId<ChatMessage>()
    const value: AttachedData<ChatMessage> = {
      message: comment.text,
      attachments: comment.attachments?.length
    }
    await this.client.addCollection(
      chunter.class.ChatMessage,
      projectId,
      issueId,
      tracker.class.Issue,
      'comments',
      value,
      commentId,
      // new Date(data.created_at).getTime(),
      comment.date
      // this.personsByName.comment.author // todo: as Ref<Account>
    )

    if (comment.attachments !== undefined) {
      for (const attach of comment.attachments) {
        const blob = await attach.blobProvider()
        const file = new File([blob], attach.title)
        const form = new FormData()
        form.append('file', file)
        form.append('type', file.type)
        form.append('size', file.size.toString())
        form.append('name', attach.title)
        const attachmentId = generateId()
        form.append('id', attachmentId)
        form.append('data', blob) // ?

        await this.fileUploader(attachmentId, form)

        const attachValue = {
          _id: attachmentId,
          _class: attachment.class.Attachment,
          attachedTo: commentId,
          attachedToClass: chunter.class.ChatMessage,
          collection: 'attachments',
          file: '' as Ref<PlatformBlob>,
          lastModified: Date.now(),
          name: file.name,
          size: file.size,
          space: projectId,
          type: 'file'
        }

        const data = new FormData()
        data.append('file', new File([blob], attach.title))

        // await client.createDoc(document.class.Document, space, attachValue, attachmentId)
      }
    }
  }

  // const file = new File([attach.blob], attach.title)
  // writeFileSync(`kitten.jpg`, new Uint8Array(await file.arrayBuffer()))
}
