// /app/courses/:id/grades — course gradebook (epic UNI-21 / sub-issue UNI-30).
//
// Faculty / teacher / TA view of the gradebook. Faculty + teacher can record
// and edit grades inline; TA is read-only on this iteration (the spec says
// "TA gets gradebook for assigned classes only" — they see the gradebook,
// they don't grade). Edits use a confirmation dialog because a grade change
// is a FERPA-disclosed mutation; the prompt makes the click intentional.
//
// Every successful read of this page emits one `grade_access_log` row per
// disclosed grade — the admin "Grade access log" page surfaces those rows.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { ClipboardList, Plus } from "lucide-react";

import {
  GRADE_STATUS_LABELS,
  type AssessmentListItem,
  type CourseListItem,
  type GradeStatus,
  type GradebookEntry,
} from "@university-hub/shared";

import { useAuth } from "@/auth/AuthContext";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/data-table";
import { toast } from "@/components/ui/use-toast";
import { ApiClientError } from "@/lib/api";
import { getCourse } from "@/lib/courses";
import {
  createCourseAssessment,
  createGrade,
  listCourseAssessments,
  listCourseGrades,
  updateGrade,
} from "@/lib/grades";

const GRADER_ROLES: ReadonlySet<string> = new Set([
  "super_admin",
  "university_admin",
  "faculty",
  "teacher",
]);

const VIEWER_ROLES: ReadonlySet<string> = new Set([
  ...GRADER_ROLES,
  "teacher_assistant",
]);

interface PageData {
  course: CourseListItem;
  assessments: AssessmentListItem[];
  grades: GradebookEntry[];
}

interface State {
  status: "loading" | "ok" | "error";
  data?: PageData;
  error?: string;
}

interface EditTarget {
  assessment: AssessmentListItem;
  studentUserId: string;
  studentName: string;
  /** Existing grade, if any. */
  existing: GradebookEntry | null;
  initialScore: string;
  initialStatus: GradeStatus;
  initialFeedback: string;
}

interface Roster {
  id: string;
  name: string;
  email: string;
}

export function CourseGradebookPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const [state, setState] = useState<State>({ status: "loading" });
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [editScore, setEditScore] = useState("");
  const [editStatus, setEditStatus] = useState<GradeStatus>("graded");
  const [editFeedback, setEditFeedback] = useState("");
  const [editLetter, setEditLetter] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [showNewAssessment, setShowNewAssessment] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newWeight, setNewWeight] = useState("0");
  const [newMaxScore, setNewMaxScore] = useState("100");

  const role = user?.role;
  const canView = !!role && VIEWER_ROLES.has(role);
  const canGrade = !!role && GRADER_ROLES.has(role);
  const canCreateAssessment =
    !!role &&
    (role === "super_admin" ||
      role === "university_admin" ||
      role === "faculty");

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      if (!id) return;
      setState({ status: "loading" });
      try {
        const [course, assessments, grades] = await Promise.all([
          getCourse(id, signal),
          listCourseAssessments(id, signal),
          listCourseGrades(id, signal),
        ]);
        if (signal?.aborted) return;
        setState({ status: "ok", data: { course, assessments, grades } });
      } catch (cause) {
        if (signal?.aborted) return;
        setState({
          status: "error",
          error:
            cause instanceof ApiClientError
              ? cause.message
              : "Could not load the gradebook.",
        });
      }
    },
    [id],
  );

  useEffect(() => {
    if (!canView) return;
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [canView, refresh]);

  const roster: Roster[] = useMemo(() => {
    if (!state.data) return [];
    const map = new Map<string, Roster>();
    for (const g of state.data.grades) {
      if (!map.has(g.student_user_id)) {
        map.set(g.student_user_id, {
          id: g.student_user_id,
          name: g.student_name,
          email: g.student_email,
        });
      }
    }
    return Array.from(map.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [state.data]);

  const gradeIndex = useMemo(() => {
    const map = new Map<string, GradebookEntry>();
    if (state.data) {
      for (const g of state.data.grades) {
        map.set(`${g.assessment_id}::${g.student_user_id}`, g);
      }
    }
    return map;
  }, [state.data]);

  function openEditDialog(
    assessment: AssessmentListItem,
    student: Roster,
    existing: GradebookEntry | null,
  ) {
    setEditTarget({
      assessment,
      studentUserId: student.id,
      studentName: student.name,
      existing,
      initialScore: existing?.score === null || existing === null
        ? ""
        : String(existing.score),
      initialStatus: existing?.status ?? "graded",
      initialFeedback: existing?.feedback ?? "",
    });
    setEditScore(
      existing?.score === null || existing === null
        ? ""
        : String(existing.score),
    );
    setEditStatus(existing?.status ?? "graded");
    setEditFeedback(existing?.feedback ?? "");
    setEditLetter(existing?.letter_grade ?? "");
  }

  async function submitGradeEdit() {
    if (!editTarget) return;
    setSubmitting(true);
    try {
      const score = editScore.trim() === "" ? null : Number(editScore);
      if (score !== null && (!Number.isFinite(score) || score < 0)) {
        toast({
          title: "Invalid score",
          description: "Score must be a non-negative number.",
          variant: "destructive",
        });
        setSubmitting(false);
        return;
      }
      const letter = editLetter.trim() === "" ? null : editLetter.trim();
      const feedback = editFeedback.trim() === "" ? null : editFeedback;

      if (editTarget.existing) {
        await updateGrade(editTarget.existing.id, {
          score,
          letter_grade: letter,
          feedback,
          status: editStatus,
        });
      } else {
        await createGrade({
          assessment_id: editTarget.assessment.id,
          student_user_id: editTarget.studentUserId,
          score,
          letter_grade: letter,
          feedback,
          status: editStatus,
        });
      }
      toast({
        title: "Grade saved",
        description: `${editTarget.assessment.title} · ${editTarget.studentName}`,
      });
      setEditTarget(null);
      await refresh();
    } catch (cause) {
      toast({
        title: "Could not save grade",
        description:
          cause instanceof ApiClientError
            ? cause.message
            : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function submitNewAssessment() {
    if (!id || !newTitle.trim()) return;
    setSubmitting(true);
    try {
      const weight = Number(newWeight);
      const maxScore = Number(newMaxScore);
      if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
        toast({
          title: "Invalid weight",
          description: "Weight must be a number between 0 and 1.",
          variant: "destructive",
        });
        setSubmitting(false);
        return;
      }
      if (!Number.isFinite(maxScore) || maxScore <= 0) {
        toast({
          title: "Invalid max score",
          description: "Max score must be greater than 0.",
          variant: "destructive",
        });
        setSubmitting(false);
        return;
      }
      await createCourseAssessment(id, {
        title: newTitle.trim(),
        weight,
        max_score: maxScore,
      });
      toast({ title: "Assessment created" });
      setShowNewAssessment(false);
      setNewTitle("");
      setNewWeight("0");
      setNewMaxScore("100");
      await refresh();
    } catch (cause) {
      toast({
        title: "Could not create assessment",
        description:
          cause instanceof ApiClientError
            ? cause.message
            : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  if (!canView) {
    return (
      <ErrorState
        title="Restricted"
        description="The gradebook is only available to faculty, teachers, and TAs assigned to this course."
      />
    );
  }

  if (state.status === "loading") {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <ErrorState title="Couldn't load gradebook" description={state.error} />
    );
  }

  const { course, assessments, grades } = state.data!;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {course.name} · Gradebook
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {course.code ? `${course.code} · ` : ""}
            {assessments.length} assessment
            {assessments.length === 1 ? "" : "s"} · {roster.length} student
            {roster.length === 1 ? "" : "s"}
          </p>
        </div>
        {canCreateAssessment ? (
          <Button onClick={() => setShowNewAssessment(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New assessment
          </Button>
        ) : null}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Grades</CardTitle>
          <CardDescription>
            Every row read is recorded in the FERPA grade access log.
            {canGrade ? " Click a cell to record or change a grade." : null}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {assessments.length === 0 ? (
            <EmptyState
              icon={ClipboardList}
              title="No assessments yet"
              description={
                canCreateAssessment
                  ? "Create one to start grading."
                  : "Faculty haven't added an assessment yet."
              }
            />
          ) : roster.length === 0 ? (
            <EmptyState
              icon={ClipboardList}
              title="No students enrolled"
              description="Enroll students in this course to see them here."
            />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Student</TableHead>
                    {assessments.map((a) => (
                      <TableHead key={a.id} className="text-right">
                        <div className="flex flex-col items-end">
                          <span>{a.title}</span>
                          <span className="text-[11px] font-normal text-muted-foreground">
                            /{a.max_score}
                          </span>
                        </div>
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {roster.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="font-medium">
                        {s.name}
                        <div className="text-xs text-muted-foreground">
                          {s.email}
                        </div>
                      </TableCell>
                      {assessments.map((a) => {
                        const grade =
                          gradeIndex.get(`${a.id}::${s.id}`) ?? null;
                        return (
                          <TableCell key={a.id} className="text-right">
                            {canGrade ? (
                              <button
                                type="button"
                                className="rounded border border-transparent px-2 py-1 text-right text-sm hover:border-input hover:bg-accent"
                                onClick={() => openEditDialog(a, s, grade)}
                              >
                                {renderGradeCell(grade)}
                              </button>
                            ) : (
                              <span className="text-sm">
                                {renderGradeCell(grade)}
                              </span>
                            )}
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {grades.length === 0 ? (
                <p className="mt-4 text-sm text-muted-foreground">
                  No grades have been recorded yet.
                </p>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={!!editTarget}
        onOpenChange={(open) => !open && setEditTarget(null)}
      >
        <DialogContent>
          {editTarget ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  {editTarget.existing ? "Change grade" : "Record grade"}
                </DialogTitle>
                <DialogDescription>
                  {editTarget.assessment.title} · {editTarget.studentName}
                  {editTarget.existing ? (
                    <>
                      {" "}
                      · A change here is recorded in the audit log and the
                      FERPA grade access log.
                    </>
                  ) : null}
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-4 py-2">
                <div className="grid gap-2">
                  <Label htmlFor="edit-score">
                    Score (max {editTarget.assessment.max_score})
                  </Label>
                  <Input
                    id="edit-score"
                    inputMode="decimal"
                    value={editScore}
                    placeholder="Leave blank for ungraded"
                    onChange={(e) => setEditScore(e.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="edit-letter">Letter grade (optional)</Label>
                  <Input
                    id="edit-letter"
                    value={editLetter}
                    onChange={(e) => setEditLetter(e.target.value)}
                    placeholder="e.g. A-"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="edit-status">Status</Label>
                  <select
                    id="edit-status"
                    className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                    value={editStatus}
                    onChange={(e) =>
                      setEditStatus(e.target.value as GradeStatus)
                    }
                  >
                    <option value="graded">{GRADE_STATUS_LABELS.graded}</option>
                    <option value="pending">
                      {GRADE_STATUS_LABELS.pending}
                    </option>
                    <option value="excused">
                      {GRADE_STATUS_LABELS.excused}
                    </option>
                  </select>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="edit-feedback">Feedback (optional)</Label>
                  <textarea
                    id="edit-feedback"
                    className="min-h-[80px] rounded-md border border-input bg-background p-2 text-sm"
                    value={editFeedback}
                    onChange={(e) => setEditFeedback(e.target.value)}
                  />
                </div>
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setEditTarget(null)}
                  disabled={submitting}
                >
                  Cancel
                </Button>
                <Button onClick={submitGradeEdit} disabled={submitting}>
                  {editTarget.existing ? "Save change" : "Record grade"}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog
        open={showNewAssessment}
        onOpenChange={(open) => !open && setShowNewAssessment(false)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New assessment</DialogTitle>
            <DialogDescription>
              Add a grade-bearing item to this course.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-2">
              <Label htmlFor="new-title">Title</Label>
              <Input
                id="new-title"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="new-weight">Weight (0 — 1)</Label>
              <Input
                id="new-weight"
                inputMode="decimal"
                value={newWeight}
                onChange={(e) => setNewWeight(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="new-max">Max score</Label>
              <Input
                id="new-max"
                inputMode="decimal"
                value={newMaxScore}
                onChange={(e) => setNewMaxScore(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowNewAssessment(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              onClick={submitNewAssessment}
              disabled={submitting || !newTitle.trim()}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function renderGradeCell(grade: GradebookEntry | null): React.ReactNode {
  if (!grade) return <span className="text-muted-foreground">—</span>;
  if (grade.status === "excused") {
    return <span className="text-muted-foreground">Excused</span>;
  }
  if (grade.status === "pending" || grade.score === null) {
    return <span className="text-muted-foreground">Pending</span>;
  }
  return (
    <span>
      {grade.score}
      {grade.letter_grade ? (
        <span className="ml-2 text-xs text-muted-foreground">
          {grade.letter_grade}
        </span>
      ) : null}
    </span>
  );
}
