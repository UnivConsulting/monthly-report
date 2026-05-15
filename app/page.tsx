import { Suspense } from "react";
import StudentClient from "./_components/StudentClient";

export default function Page() {
  return (
    <Suspense fallback={null}>
      <StudentClient />
    </Suspense>
  );
}
