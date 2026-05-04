// /app/courses/:id — view, edit/delete entry points, and faculty/teacher/TA/
// student assignment management via course_assignments (epic UNI-1 §18).

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  ClipboardList,
  Pencil,
  Plus,
  Trash2,
  UserMinus,
  UsersRound,
} from "lucide-react";

import {
  COURSE_ASSIGNMENT_ROLE_LABELS,
  COURSE_ASSIGNMENT_ROLES,
  type CourseAssignmentListItem,
  type CourseAssignmentRole,
  type CourseListItem,
  type UserListItem,
} from "@university-hub/shared";

import { useAuth } from "@/auth/AuthContext";
import {
  CourseAssignmentRoleBadge,
  CourseStatusBadge,
} from "@/components/UserBadges";
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
import { ErrorState } from "@/components/ui/error-state";
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
import {
  createCourseAssignment,
  deleteCourse,
  deleteCourseAssignment,
  getCourse,
  listCourseAssignments,
} from "@/lib/courses";
import { listUsers } from "@/lib/users";

interface State {
  status: "loading" | "ok" | "error";
  data?: CourseListItem;
  error?: string;
}

export function CourseDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [state, setState] = useState<State>({ status: "loading" });
  const [assignments, setAssignments] = useState<CourseAssignmentListItem[]>([]);
  const [assignmentsLoading, setAssignmentsLoading] = useState(false);
  const [assignDialogOpen, setAssignDialogOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  function reloadAssignments(courseId: string, signal?: AbortSignal) {
    setAssignmentsLoading(true);
    listCourseAssignments(courseId, signal)
      .then((rows) => {
        if (signal?.aborted) return;
        setAssignments(rows);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!signal?.aborted) setAssignmentsLoading(false);
      });
  }

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    setState({ status: "loading" });
    getCourse(id, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setState({ status: "ok", data });
        reloadAssignments(data.id, controller.signal);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          error:
            cause instanceof ApiClientError
              ? cause.message
              : "Could not load course.",
        });
      });
    return () => controller.abort();
  }, [id]);

  const canManage =
    state.data && user
      ? user.role === "super_admin" ||
        (user.role === "university_admin" &&
          user.university_id === state.data.university_id)
      : false;

  // Faculty / teacher / TA assigned to the course can open the gradebook
  // (the worker enforces the assignment check). Admins also pass.
  const canOpenGradebook =
    !!user &&
    (user.role === "super_admin" ||
      user.role === "university_admin" ||
      user.role === "faculty" ||
      user.role === "teacher" ||
      user.role === "teacher_assistant");

  async function onConfirmDelete() {
    if (!id) return;
    setDeleting(true);
    try {
      await deleteCourse(id);
      toast({
        title: "Course deleted",
        description: state.data?.name ?? "Course removed.",
        variant: "success",
      });
      navigate("/app/courses");
    } catch (cause) {
      toast({
        title: "Could not delete",
        description:
          cause instanceof ApiClientError
            ? cause.message
            : "Delete failed. Please try again.",
        variant: "destructive",
      });
      setDeleting(false);
      setDeleteOpen(false);
    }
  }

  async function onRemoveAssignment(assignmentId: string) {
    if (!id) return;
    try {
      await deleteCourseAssignment(id, assignmentId);
      setAssignments((current) => current.filter((a) => a.id !== assignmentId));
      toast({ title: "Removed", variant: "success" });
    } catch (cause) {
      toast({
        title: "Could not remove",
        description:
          cause instanceof ApiClientError
            ? cause.message
            : "Removal failed. Please try again.",
        variant: "destructive",
      });
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Button asChild size="sm" variant="ghost">
          <Link to="/app/courses">
            <ArrowLeft className="h-4 w-4" />
            Back
          </Link>
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">Course</h1>
      </div>

      {state.status === "loading" ? (
        <Card className="space-y-3 p-6">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-1/3" />
        </Card>
      ) : state.status === "error" ? (
        <ErrorState title="Couldn't load course" description={state.error} />
      ) : state.data ? (
        <>
          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-3">
              <div>
                <CardTitle>{state.data.name}</CardTitle>
                <CardDescription>
                  {state.data.code ?? "No code"} ·{" "}
                  {state.data.department_name ?? "Unassigned department"} ·{" "}
                  {state.data.university_name ?? "—"}
                </CardDescription>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <CourseStatusBadge status={state.data.status} />
                {canOpenGradebook ? (
                  <Button asChild size="sm" variant="outline">
                    <Link to={`/app/courses/${state.data.id}/grades`}>
                      <ClipboardList className="h-4 w-4" />
                      Gradebook
                    </Link>
                  </Button>
                ) : null}
                {canManage ? (
                  <>
                    <Button asChild size="sm" variant="outline">
                      <Link to={`/app/courses/${state.data.id}/edit`}>
                        <Pencil className="h-4 w-4" />
                        Edit
                      </Link>
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => setDeleteOpen(true)}
                    >
                      <Trash2 className="h-4 w-4" />
                      Delete
                    </Button>
                  </>
                ) : null}
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {state.data.description ? (
                <p className="text-sm">{state.data.description}</p>
              ) : (
                <p className="text-sm italic text-muted-foreground">
                  No description set.
                </p>
              )}
              <div className="text-sm text-muted-foreground">
                Created {new Date(state.data.created_at).toLocaleString()}
              </div>
              <div className="text-sm text-muted-foreground">
                Last updated {new Date(state.data.updated_at).toLocaleString()}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <div>
                <CardTitle className="text-base">Assignments</CardTitle>
                <CardDescription>
                  Faculty, teachers, TAs, students, and viewers for this course.
                  Each assignment writes to `course_assignments` and a
                  `course.updated` audit row.
                </CardDescription>
              </div>
              {canManage ? (
                <Button size="sm" onClick={() => setAssignDialogOpen(true)}>
                  <Plus className="h-4 w-4" />
                  Assign
                </Button>
              ) : null}
            </CardHeader>
            <CardContent>
              {assignmentsLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-4 w-1/2" />
                </div>
              ) : assignments.length === 0 ? (
                <div className="flex items-center gap-2 rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
                  <UsersRound className="h-4 w-4" />
                  No one is assigned to this course yet.
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead>Assigned role</TableHead>
                      {canManage ? (
                        <TableHead className="text-right">Actions</TableHead>
                      ) : null}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {assignments.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="font-medium">{row.user_name}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {row.user_email}
                        </TableCell>
                        <TableCell>
                          <CourseAssignmentRoleBadge role={row.role} />
                        </TableCell>
                        {canManage ? (
                          <TableCell className="text-right">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => onRemoveAssignment(row.id)}
                            >
                              <UserMinus className="h-4 w-4" />
                              Remove
                            </Button>
                          </TableCell>
                        ) : null}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {canManage ? (
            <AssignDialog
              open={assignDialogOpen}
              onClose={() => setAssignDialogOpen(false)}
              courseId={state.data.id}
              existing={assignments}
              onAssigned={(row) => {
                setAssignments((cur) => [...cur, row]);
                setAssignDialogOpen(false);
              }}
            />
          ) : null}

          <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Delete {state.data.name}?</DialogTitle>
                <DialogDescription>
                  This removes the course and every related assignment. The
                  delete is recorded in the audit log.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setDeleteOpen(false)}
                  disabled={deleting}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={onConfirmDelete}
                  disabled={deleting}
                >
                  {deleting ? "Deleting…" : "Confirm delete"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      ) : null}
    </div>
  );
}

interface AssignDialogProps {
  open: boolean;
  onClose: () => void;
  courseId: string;
  existing: CourseAssignmentListItem[];
  onAssigned: (row: CourseAssignmentListItem) => void;
}

function AssignDialog({ open, onClose, courseId, existing, onAssigned }: AssignDialogProps) {
  const [users, setUsers] = useState<UserListItem[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [userId, setUserId] = useState<string>("");
  const [role, setRole] = useState<CourseAssignmentRole>("teacher");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setUsersLoading(true);
    setError(null);
    listUsers({}, controller.signal)
      .then((rows) => {
        if (controller.signal.aborted) return;
        setUsers(rows);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!controller.signal.aborted) setUsersLoading(false);
      });
    return () => controller.abort();
  }, [open]);

  // Filter out (user, role) pairs that already exist so the admin can't try
  // to recreate them. Schema enforces UNIQUE(course, user, role) anyway.
  const availableUsers = useMemo(() => {
    const taken = new Set(existing.filter((a) => a.role === role).map((a) => a.user_id));
    return users.filter((u) => !taken.has(u.id));
  }, [users, existing, role]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!userId) {
      setError("Select a user.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const created = await createCourseAssignment(courseId, {
        user_id: userId,
        role,
      });
      onAssigned(created);
      setUserId("");
      setRole("teacher");
      toast({ title: "Assigned", variant: "success" });
    } catch (cause) {
      setError(
        cause instanceof ApiClientError
          ? cause.message
          : "Could not assign user.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign someone to this course</DialogTitle>
          <DialogDescription>
            The role uses the spec's enum: faculty, teacher, teacher_assistant,
            student, viewer. Each assignment is unique per (user, role).
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="assign-role">Role</Label>
            <select
              id="assign-role"
              value={role}
              onChange={(e) => setRole(e.target.value as CourseAssignmentRole)}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              disabled={submitting}
            >
              {COURSE_ASSIGNMENT_ROLES.map((r) => (
                <option key={r} value={r}>
                  {COURSE_ASSIGNMENT_ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="assign-user">User</Label>
            <select
              id="assign-user"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              disabled={submitting || usersLoading}
            >
              <option value="" disabled>
                {usersLoading ? "Loading users…" : "Select a user…"}
              </option>
              {availableUsers.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.email})
                </option>
              ))}
            </select>
          </div>
          {error ? (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || !userId}>
              {submitting ? "Assigning…" : "Assign"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
