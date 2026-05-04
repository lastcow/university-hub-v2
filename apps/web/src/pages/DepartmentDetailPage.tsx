// /app/departments/:id — view + entry points to edit/delete + staff
// assignment placeholder (real staff directory pages land in UNI-13).

import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  BookOpen,
  Pencil,
  Trash2,
  UsersRound,
} from "lucide-react";

import type { CourseListItem, DepartmentListItem } from "@university-hub/shared";

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
import { ErrorState } from "@/components/ui/error-state";
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
import { listCourses } from "@/lib/courses";
import { deleteDepartment, getDepartment } from "@/lib/departments";

interface State {
  status: "loading" | "ok" | "error";
  data?: DepartmentListItem;
  error?: string;
}

export function DepartmentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [state, setState] = useState<State>({ status: "loading" });
  const [courses, setCourses] = useState<CourseListItem[]>([]);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    setState({ status: "loading" });
    Promise.all([
      getDepartment(id, controller.signal),
      listCourses({ department: id }, controller.signal).catch(() => [] as CourseListItem[]),
    ])
      .then(([dept, list]) => {
        if (controller.signal.aborted) return;
        setState({ status: "ok", data: dept });
        setCourses(list);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          error:
            cause instanceof ApiClientError
              ? cause.message
              : "Could not load department.",
        });
      });
    return () => controller.abort();
  }, [id]);

  const canEdit =
    state.data && user
      ? user.role === "super_admin" ||
        (user.role === "university_admin" &&
          user.university_id === state.data.university_id)
      : false;

  async function onConfirmDelete() {
    if (!id) return;
    setDeleting(true);
    try {
      await deleteDepartment(id);
      toast({
        title: "Department deleted",
        description: state.data?.name ?? "Department removed.",
        variant: "success",
      });
      navigate("/app/departments");
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

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Button asChild size="sm" variant="ghost">
          <Link to="/app/departments">
            <ArrowLeft className="h-4 w-4" />
            Back
          </Link>
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">Department</h1>
      </div>

      {state.status === "loading" ? (
        <Card className="space-y-3 p-6">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-1/3" />
        </Card>
      ) : state.status === "error" ? (
        <ErrorState title="Couldn't load department" description={state.error} />
      ) : state.data ? (
        <>
          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-3">
              <div>
                <CardTitle>{state.data.name}</CardTitle>
                <CardDescription>
                  {state.data.code ?? "No code"} ·{" "}
                  {state.data.university_name ?? "Unknown university"}
                </CardDescription>
              </div>
              {canEdit ? (
                <div className="flex flex-wrap gap-2">
                  <Button asChild size="sm" variant="outline">
                    <Link to={`/app/departments/${state.data.id}/edit`}>
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
                </div>
              ) : null}
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
            <CardHeader>
              <CardTitle className="text-base">Courses in this department</CardTitle>
              <CardDescription>
                {courses.length} {courses.length === 1 ? "course" : "courses"} reference
                this department.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {courses.length === 0 ? (
                <div className="flex items-center gap-2 rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
                  <BookOpen className="h-4 w-4" />
                  No courses yet. Create one from the Courses page.
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Code</TableHead>
                      <TableHead className="text-right">Assignments</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {courses.map((c) => (
                      <TableRow key={c.id}>
                        <TableCell className="font-medium">
                          <Link
                            to={`/app/courses/${c.id}`}
                            className="hover:underline"
                          >
                            {c.name}
                          </Link>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {c.code ?? "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {c.assignment_count}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Staff &amp; faculty</CardTitle>
              <CardDescription>
                Department-level staff/faculty assignment lands with the
                directory pages in UNI-13. Course-level assignments
                (faculty / teachers / TAs / students) are managed on each
                course's detail page.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2 rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
                <UsersRound className="h-4 w-4" />
                Coming soon — directory pages will let you map faculty,
                teachers, and TAs to a department.
              </div>
            </CardContent>
          </Card>

          <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Delete {state.data.name}?</DialogTitle>
                <DialogDescription>
                  {courses.length === 0
                    ? "This will remove the department permanently. The action is recorded in the audit log."
                    : "This department still has courses. The backend will reject the delete to prevent orphaning. Reassign or remove the courses first."}
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
